import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function writePrivateJson(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(data));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
    let dir;
    try { dir = openSync(dirname(file), "r"); fsyncSync(dir); }
    catch (error) { if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error.code)) throw error; }
    finally { if (dir !== undefined) closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
