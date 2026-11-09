import test from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { fileURLToPath } from "node:url";
import { getSqliteTables, getSqliteTableRows, executeSqliteQuery, openSqliteFile } from "./sqliteDatabase.js";

const SQL = await initSqlJs({ locateFile: () => fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.wasm")) });

test("lists imported SQLite tables and their columns", () => {
  const db = new SQL.Database();
  db.run("CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
  const tables = getSqliteTables(db);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, "departments");
  assert.deepEqual(tables[0].columns.map((column) => column.name), ["id", "name"]);
  assert.equal(tables[0].columns[0].pk, true);
  db.close();
});

test("reads table rows and executes edits locally", () => {
  const db = new SQL.Database();
  db.run("CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO departments VALUES (1, 'Engineering');");
  assert.deepEqual(getSqliteTableRows(db, "departments"), {
    columns: ["id", "name"],
    rows: [{ id: 1, name: "Engineering" }],
  });
  executeSqliteQuery(db, "INSERT INTO departments VALUES (2, 'Design');");
  assert.equal(getSqliteTableRows(db, "departments").rows.length, 2);
  db.close();
});

test("exports a valid SQLite database with local edits", () => {
  const db = new SQL.Database();
  db.run("CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO departments VALUES (1, 'Engineering');");
  const bytes = db.export();
  const reopened = new SQL.Database(bytes);
  assert.deepEqual(getSqliteTableRows(reopened, "departments").rows, [{ id: 1, name: "Engineering" }]);
  reopened.close();
  db.close();
});

test("opens a .sql file as a new local database and exposes its tables", async () => {
  const file = new File(["CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO departments VALUES (1, 'Engineering');"], "departments.sql");
  const opened = await openSqliteFile(SQL, file);
  assert.deepEqual(getSqliteTables(opened.db).map((table) => table.name), ["departments"]);
  assert.equal(getSqliteTableRows(opened.db, "departments").rows[0].name, "Engineering");
  opened.db.close();
});

test("creates local tables from data-only INSERT SQL before importing rows", async () => {
  const script = "INSERT INTO department_list (id, name, created_at) VALUES (9, 'Computing', '2026-05-14') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;";
  const file = new File([script], "departments.sql");
  const opened = await openSqliteFile(SQL, file);
  assert.deepEqual(getSqliteTables(opened.db).map((table) => table.name), ["department_list"]);
  assert.deepEqual(getSqliteTableRows(opened.db, "department_list").rows, [{ id: 9, name: "Computing", created_at: "2026-05-14" }]);
  assert.deepEqual(opened.inferredTables, ["department_list"]);
  opened.db.close();
});

test("still infers a missing table when the SQL file creates other tables first", async () => {
  const script = "CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO programs (id, title) VALUES (1, 'Robotics');";
  const opened = await openSqliteFile(SQL, new File([script], "mixed.sql"));
  assert.deepEqual(getSqliteTables(opened.db).map((table) => table.name), ["departments", "programs"]);
  assert.deepEqual(getSqliteTableRows(opened.db, "programs").rows, [{ id: 1, title: "Robotics" }]);
  assert.deepEqual(opened.inferredTables, ["programs"]);
  opened.db.close();
});

test("opens a .db file directly without sending it to a hosted connection", async () => {
  const source = new SQL.Database();
  source.run("CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO departments VALUES (1, 'Engineering');");
  const bytes = source.export();
  const file = new File([bytes], "departments.db");
  const opened = await openSqliteFile(SQL, file);
  assert.deepEqual(getSqliteTables(opened.db).map((table) => table.name), ["departments"]);
  source.close();
  opened.db.close();
});

test("rejects unsupported local database file extensions", async () => {
  await assert.rejects(openSqliteFile(SQL, new File(["x"], "data.txt")), /Choose a \.db or \.sql file/);
});
