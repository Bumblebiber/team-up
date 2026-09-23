import fs from "node:fs";
import path from "node:path";

/** JSON.parse a file; ENOENT -> null; malformed JSON rethrows. */
export function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function atomicWriteText(filePath, text, { mode } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  let renamed = false;
  try {
    if (mode != null) {
      fs.writeFileSync(tmp, payload, { mode });
      fs.chmodSync(tmp, mode);
    } else {
      fs.writeFileSync(tmp, payload);
    }
    fs.renameSync(tmp, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
}
