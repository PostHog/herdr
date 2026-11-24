I'm on a team that GitHub asks to review any PR touching code we own. Most of those PRs are other teams
working in shared files, and a teammate's approval covers them. Tell me whether this one needs my eyes.

Likely needs me:
- Changes to how the MCP server runs tools: the tool executor, exec, request handling, state, sessions.
- Auth, OAuth, API scopes, or what a token or key is allowed to do.
- The tool catalog's shape: how tools are generated, listed, filtered or described to clients, the
  server instructions, prompt templates agents read, guidance.
- The CLI, skills, or anything shipped to MCP clients and plugins.
- Anything that could break existing MCP clients, or that changes behaviour for every tool.
- A design choice my team should weigh in on, even when the diff is small.

Likely doesn't need me:
- Another team adding or changing its own tools: its `tools.yaml`, generated API clients and schema
  files, plus the matching registration lines and snapshot updates in shared lists and tests.
- Generated files only, lockfiles, or version bumps.
- Tests only, or a typo or copy fix.

When unsure, say it needs me.
