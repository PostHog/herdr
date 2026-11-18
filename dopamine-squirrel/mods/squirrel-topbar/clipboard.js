// Saves or restores the whole clipboard (every item and type, images too), so a button can borrow it.
// osascript -l JavaScript clipboard.js save|restore <folder>
ObjC.import("AppKit");
function run(argv) {
  const [mode, dir] = argv, pb = $.NSPasteboard.generalPasteboard, manifest = `${dir}/manifest.json`;
  if (mode === "save") {
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), null);
    const items = pb.pasteboardItems, saved = [];
    for (let i = 0; i < (items.isNil() ? 0 : items.count); i++) {
      const item = items.objectAtIndex(i), types = item.types, entry = [];
      for (let j = 0; j < types.count; j++) {
        const type = ObjC.unwrap(types.objectAtIndex(j)), data = item.dataForType(type);
        if (data.isNil()) continue;
        const file = `${dir}/${i}-${j}`;
        data.writeToFileAtomically(file, true);
        entry.push([type, file]);
      }
      saved.push(entry);
    }
    $(JSON.stringify(saved)).writeToFileAtomicallyEncodingError(manifest, true, $.NSUTF8StringEncoding, null);
    return;
  }
  const saved = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(manifest, $.NSUTF8StringEncoding, null)));
  pb.clearContents;
  const objects = $.NSMutableArray.array;
  for (const entry of saved) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, file] of entry) item.setDataForType($.NSData.dataWithContentsOfFile(file), type);
    objects.addObject(item);
  }
  if (objects.count) pb.writeObjects(objects);
}
