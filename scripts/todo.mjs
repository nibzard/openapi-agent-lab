#!/usr/bin/env node
/**
 * Tiny tracker for to-do.json task statuses.
 * Usage:
 *   node scripts/todo.mjs set T004 doing
 *   node scripts/todo.mjs show T004
 *   node scripts/todo.mjs remaining
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../to-do.json", import.meta.url);
const doc = JSON.parse(readFileSync(path, "utf8"));
const [cmd, id, status] = process.argv.slice(2);

function usage() {
  console.error("usage: todo.mjs set <ID> <todo|doing|blocked|done> | show <ID> | remaining");
  process.exit(2);
}

if (cmd === "set") {
  if (!id || !status) usage();
  const task = doc.tasks.find((t) => t.id === id);
  if (!task) {
    console.error(`unknown task ${id}`);
    process.exit(2);
  }
  if (!["todo", "doing", "blocked", "done"].includes(status)) usage();
  task.status = status;
  task.updated_at = new Date().toISOString();
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  console.log(`${id} -> ${status}`);
} else if (cmd === "show") {
  const task = doc.tasks.find((t) => t.id === id);
  if (!task) {
    console.error(`unknown task ${id}`);
    process.exit(2);
  }
  console.log(JSON.stringify(task, null, 2));
} else if (cmd === "remaining") {
  const open = doc.tasks.filter((t) => t.status !== "done");
  console.log(`${open.length}/${doc.tasks.length} tasks not done`);
  for (const t of open) console.log(`${t.status.padEnd(8)} ${t.id} ${t.title}`);
} else {
  usage();
}
