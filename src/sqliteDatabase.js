function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function resultRows(result) {
  return {
    columns: result.columns,
    rows: result.values.map((values) => Object.fromEntries(
      result.columns.map((column, index) => [column, values[index]]),
    )),
  };
}

function unquoteIdentifier(identifier) {
  const value = identifier.trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replaceAll('""', '"');
  if (value.startsWith("`") && value.endsWith("`")) return value.slice(1, -1).replaceAll("``", "`");
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
}

function inferInsertTables(sql) {
  const tables = new Map();
  const insertPattern = /\bINSERT(?:\s+OR\s+\w+)?\s+INTO\s+((?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]+\]|[\w$]+))\s*\(([^)]+)\)\s*VALUES\s*\(/gi;
  let match;
  while ((match = insertPattern.exec(sql))) {
    const name = unquoteIdentifier(match[1]);
    const columns = match[2].split(",").map(unquoteIdentifier).filter(Boolean);
    if (!name || !columns.length) continue;
    const end = sql.indexOf(";", insertPattern.lastIndex);
    const statement = sql.slice(match.index, end < 0 ? sql.length : end);
    const conflict = statement.match(/\bON\s+CONFLICT\s*\(([^)]+)\)/i);
    const table = tables.get(name) ?? { columns: new Set(), primaryKey: new Set() };
    columns.forEach((column) => table.columns.add(column));
    if (conflict) conflict[1].split(",").map(unquoteIdentifier).forEach((column) => table.primaryKey.add(column));
    tables.set(name, table);
  }
  return tables;
}

function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote && quote !== "]") index += 1;
        else quote = "";
      } else if (quote === "]" && char === "]") quote = "";
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      quote = char === "[" ? "]" : char;
      continue;
    }
    if (char === ";") {
      statements.push(sql.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < sql.length) statements.push(sql.slice(start));
  return statements;
}

function tableExists(db, name) {
  return db.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${JSON.stringify(name)}`).length > 0;
}

function runSqlScript(db, script) {
  const inferredTables = new Set();
  for (const statement of splitSqlStatements(script)) {
    if (!statement.trim()) continue;
    try {
      db.run(statement);
    } catch (error) {
      const inferred = inferInsertTables(statement);
      const missingTables = [...inferred].filter(([name]) => !tableExists(db, name));
      if (!/no such table:/i.test(error.message) || !missingTables.length) throw error;
      const missing = new Map(missingTables);
      createInferredTables(db, missing);
      db.run(statement);
      missingTables.forEach(([name]) => inferredTables.add(name));
    }
  }
  return [...inferredTables];
}

function createInferredTables(db, tables) {
  for (const [name, table] of tables) {
    const columns = [...table.columns];
    const primaryKey = [...table.primaryKey].filter((column) => table.columns.has(column));
    const definitions = columns.map(quoteIdentifier);
    if (primaryKey.length) definitions.push(`PRIMARY KEY (${primaryKey.map(quoteIdentifier).join(", ")})`);
    db.run(`CREATE TABLE ${quoteIdentifier(name)} (${definitions.join(", ")})`);
  }
}

export async function openSqliteFile(SQL, file) {
  const extension = String(file?.name ?? "").split(".").at(-1)?.toLowerCase();
  if (extension !== "db" && extension !== "sql") {
    throw new Error("Choose a .db or .sql file.");
  }
  if (file.size > 100 * 1024 * 1024) {
    throw new Error("Database files must be 100 MB or smaller.");
  }
  if (extension === "db") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error("This .db file is empty (0 bytes). Open the .sql seed to create a local database, or choose a populated SQLite .db file.");
    }
    const sqliteHeader = [83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0];
    if (!sqliteHeader.every((byte, index) => bytes[index] === byte)) {
      throw new Error("This file is not a SQLite database. Choose a SQLite .db file or a .sql script.");
    }
    return { db: new SQL.Database(bytes), inferredTables: [] };
  }
  const script = await file.text();
  const db = new SQL.Database();
  try {
    const inferredTables = runSqlScript(db, script);
    return { db, inferredTables };
  } catch (error) {
    db.close();
    const missingTable = error.message.match(/no such table:\s*["`\[]?([^"`\]\s.]+)["`\]]?/i)?.[1];
    const alterTarget = script.match(/\bALTER\s+TABLE\s+(["`\[]?[\w.]+["`\]]?)/i)?.[1];
    if (missingTable && alterTarget) {
      throw new Error(`"${file.name}" is a migration, not a full database export. It tries to alter existing table "${missingTable}", but that table is not in the local database. Import a populated SQLite .db or a full SQL schema/data dump instead.`);
    }
    throw new Error(`Could not import SQL into the local SQLite database: ${error.message}`);
  }
}

export function getSqliteTables(db) {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const names = result[0]?.values.map(([name]) => String(name)) ?? [];
  return names.map((name) => {
    const columns = db.exec(`PRAGMA table_info(${quoteIdentifier(name)})`)[0]?.values ?? [];
    const foreignKeys = db.exec(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`)[0]?.values ?? [];
    const foreignKeyColumns = new Set(foreignKeys.map((row) => String(row[3])));
    return {
      name,
      perms: { c: true, r: true, u: true, d: true },
      columns: columns.map((column) => ({
        name: String(column[1]),
        type: String(column[2] ?? ""),
        pk: Number(column[5]) > 0,
        fk: foreignKeyColumns.has(String(column[1])),
      })),
    };
  });
}

export function getSqliteTableRows(db, tableName, limit = 100, offset = 0) {
  const safeLimit = Math.max(0, Math.min(Number(limit) || 100, 1000));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const result = db.exec(
    `SELECT * FROM ${quoteIdentifier(tableName)} LIMIT ${safeLimit} OFFSET ${safeOffset}`,
  )[0];
  return result ? resultRows(result) : { columns: [], rows: [] };
}

export function executeSqliteQuery(db, sql) {
  const results = db.exec(sql);
  const result = results.at(-1);
  return result ? resultRows(result) : { columns: [], rows: [] };
}

export function exportSqliteDatabase(db) {
  return db.export();
}
