import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.umask(0o077);
export const directory = path.resolve(
  process.env.XUYE_DATA ||
    fileURLToPath(new URL("../.private", import.meta.url)),
);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(path.join(directory, "workspace.sqlite"));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY,v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shares(token TEXT PRIMARY KEY,doc TEXT NOT NULL,version INTEGER NOT NULL,title TEXT NOT NULL,html TEXT NOT NULL,prd TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,UNIQUE(doc,version));
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY,token TEXT NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,stamp INTEGER NOT NULL);`);
export function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export const setting = (k) =>
  db.prepare("SELECT v FROM config WHERE k=?").get(k)?.v;
export const set = (k, v) =>
  db.prepare("INSERT OR REPLACE INTO config VALUES(?,?)").run(k, v);
export const token = () => randomBytes(32).toString("base64url");
const hash = (v) => createHash("sha256").update(v).digest("hex");
export function fault(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
const passwordRecord = (password) => {
  const salt = token();
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
};

if (!setting("username"))
  set("username", process.env.XUYE_USERNAME?.trim() || "admin");
if (!setting("password")) {
  const password = process.env.XUYE_PASSWORD || token().slice(0, 22);
  if (!process.env.XUYE_PASSWORD)
    fs.writeFileSync(
      path.join(directory, "首次登录密码.txt"),
      password + "\n",
      {
        mode: 0o600,
      },
    );
  set("password", passwordRecord(password));
}

export function setOwnerCredentials(username, password) {
  username = username.trim();
  if (!username || !password) fault("请输入账号和密码");
  const record = passwordRecord(password);
  transaction(() => {
    set("username", username);
    set("password", record);
    db.exec("DELETE FROM sessions");
  });
}

export function login(username, password, remember) {
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username.trim() ||
    !password
  )
    fault("请输入账号和密码");
  const [salt, expected] = setting("password").split(":");
  const passwordMatches = timingSafeEqual(
    Buffer.from(expected, "hex"),
    scryptSync(password, salt, 64),
  );
  if (!passwordMatches || username.trim() !== setting("username"))
    fault("账号或密码不正确", 401);
  const id = token(),
    seconds = (remember ? 30 : 1) * 86400;
  db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
  db.prepare("INSERT INTO sessions VALUES(?,?)").run(
    hash(id),
    Date.now() + seconds * 1000,
  );
  return { id, seconds };
}
export function session(cookie) {
  const id = (cookie || "").match(/(?:^|;\s*)xuye=([\w-]{40,50})(?:;|$)/)?.[1];
  return (
    id &&
    db
      .prepare("SELECT token FROM sessions WHERE token=? AND expires>?")
      .get(hash(id), Date.now())?.token
  );
}
const keyPath = path.join(directory, "master.key");
if (!fs.existsSync(keyPath))
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
const key = fs.readFileSync(keyPath);
export function seal(value) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  return [
    iv,
    Buffer.concat([c.update(value, "utf8"), c.final()]),
    c.getAuthTag(),
  ]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function unseal(value) {
  if (!value) return "";
  const [iv, c, tag] = value.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(c), d.final()]).toString();
}
