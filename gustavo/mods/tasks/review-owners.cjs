// The teams (and people) responsible for a pull request's changes, for the Tasks panel's
// "Request review" button. Prints one JSON object; errors print as {"error": ...}, exit 0.
//
//   node review-owners.cjs <owner/repo> <number>
//
// PostHog/posthog: the same owners its auto-assign-reviewers bot would request (owners.yaml,
// through the repo's own resolver and footprint rules, read from the local checkout), plus the
// CODEOWNERS teams whose approval is required. Any other repo: its CODEOWNERS. The matcher and
// the bot's rules come from the posthog checkout, so there is one implementation of each.
//
// Output: { owners: [{ reviewer, team, why, picked }], requested: [reviewer], author, draft }
//   reviewer: what `gh pr edit --add-reviewer` takes ("PostHog/team-x" or a login).
//   picked: the bot would request it (or CODEOWNERS requires it); the others are minor owners.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const POSTHOG = path.join(os.homedir(), 'dev/posthog/posthog')
const MONOREPO = 'PostHog/posthog'
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
const RESOLVER =
    "import sys, runpy; sys.path.insert(0, 'packages/owners-yaml'); runpy.run_module('owners_yaml', run_name='__main__')"

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

function changedFiles(repo, number) {
    // --paginate --slurp: one JSON array of pages.
    const pages = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}/files?per_page=100`, '--paginate', '--slurp']))
    return pages.flat().map((f) => ({
        filename: f.filename,
        additions: f.additions || 0,
        deletions: f.deletions || 0,
        status: f.status,
        previousFilename: f.previous_filename || null,
    }))
}

function codeowners(repo) {
    for (const p of CODEOWNERS_PATHS) {
        try {
            return Buffer.from(JSON.parse(gh(['api', `repos/${repo}/contents/${p}`])).content, 'base64').toString('utf8')
        } catch {
            // not at this path
        }
    }
    return null
}

// "@PostHog/team-x" → "PostHog/team-x"; "@alice" → "alice".
const reviewerOf = (token) => token.replace(/^@/, '')

function fromCodeowners(repo, files) {
    const text = codeowners(repo)
    if (!text) return []
    const { parse } = require(path.join(POSTHOG, '.github/scripts/codeowners.js'))
    const rules = parse(text)
    const byOwner = new Map()
    for (const f of files) {
        for (const p of f.previousFilename ? [f.filename, f.previousFilename] : [f.filename]) {
            for (const token of rules.ownersOf(p)) {
                if (!token.startsWith('@')) continue // an email can't be requested
                const n = byOwner.get(token) ?? 0
                byOwner.set(token, n + 1)
            }
        }
    }
    return [...byOwner].map(([token, n]) => ({
        reviewer: reviewerOf(token),
        team: token.includes('/'),
        why: `CODEOWNERS, ${n} file${n === 1 ? '' : 's'}`,
        picked: true,
    }))
}

function fromOwnersYaml(files) {
    const bot = require(path.join(POSTHOG, '.github/scripts/assign-reviewers.js'))
    const out = execFileSync('uv', ['run', '--quiet', '--no-project', '--with', 'pyyaml==6.0.2', 'python', '-I', '-c', RESOLVER], {
        cwd: POSTHOG,
        input: files.flatMap((f) => (f.previousFilename ? [f.filename, f.previousFilename] : [f.filename])).join('\n'),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
    const resolution = JSON.parse(out)
    const footprints = bot.computeOwnerFootprints(resolution, files)
    const additions = bot.computeAdditionOwners(resolution, files)
    const sensitive = bot.computeSensitiveOwners(resolution, files)
    const { requested, demoted } = bot.classifyOwnersWithPinned(footprints, [...additions, ...sensitive])
    const why = (f) =>
        f.paths ? `owners.yaml: ${f.paths.slice(0, 2).join(', ')}` : `owners.yaml: ${f.fileCount} file${f.fileCount === 1 ? '' : 's'}, ${f.lines} lines`
    return [
        ...requested.map((f) => ({ reviewer: reviewerOf(f.owner), team: f.type === 'team', why: why(f), picked: true })),
        ...demoted.map((f) => ({ reviewer: reviewerOf(f.owner), team: f.type === 'team', why: `${why(f)} (minor)`, picked: false })),
    ]
}

function main() {
    const [repo, number] = process.argv.slice(2)
    if (!repo || !number) throw new Error('usage: review-owners.cjs <owner/repo> <number>')
    if (!fs.existsSync(path.join(POSTHOG, '.github/scripts/codeowners.js'))) {
        throw new Error(`Needs the posthog checkout at ${POSTHOG}`)
    }
    const pr = JSON.parse(gh(['pr', 'view', number, '--repo', repo, '--json', 'author,isDraft,reviewRequests']))
    const files = changedFiles(repo, number)
    const found = [...(repo === MONOREPO ? fromOwnersYaml(files) : []), ...fromCodeowners(repo, files)]
    // One entry per reviewer: picked wins over minor, and the author can't review their own PR.
    const owners = new Map()
    for (const o of found) {
        if (o.reviewer.toLowerCase() === pr.author.login.toLowerCase()) continue
        const had = owners.get(o.reviewer)
        if (!had || (o.picked && !had.picked)) owners.set(o.reviewer, had ? { ...o, why: `${had.why}; ${o.why}` } : o)
    }
    const org = repo.split('/')[0]
    const requested = pr.reviewRequests.map((r) => (r.slug ? `${org}/${r.slug}` : r.login)).filter(Boolean)
    return { owners: [...owners.values()], requested, author: pr.author.login, draft: pr.isDraft }
}

try {
    console.log(JSON.stringify(main()))
} catch (e) {
    console.log(JSON.stringify({ error: String(e.stderr || e.message || e).trim().split('\n').pop() }))
}
