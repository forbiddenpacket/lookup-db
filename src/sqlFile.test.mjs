import test from "node:test";
import assert from "node:assert/strict";
import { readSqlFile, MAX_SQL_FILE_SIZE } from "./sqlFile.js";

test("reads SQL contents from a .sql file without changing the text", async () => {
  const source = "-- keep formatting\nSELECT 1;\n";
  const file = new File([source], "report.SQL", { type: "text/plain" });
  assert.equal(await readSqlFile(file), source);
});

test("rejects files that are not .sql", async () => {
  const file = new File(["SELECT 1"], "query.txt");
  await assert.rejects(readSqlFile(file), /Choose a \.sql file/);
});

test("rejects SQL files above the import size limit", async () => {
  const file = { name: "large.sql", size: MAX_SQL_FILE_SIZE + 1, text: async () => "" };
  await assert.rejects(readSqlFile(file), /5 MB/);
});
