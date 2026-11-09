export const MAX_SQL_FILE_SIZE = 5 * 1024 * 1024;

export async function readSqlFile(file) {
  if (!file?.name?.toLowerCase().endsWith(".sql")) {
    throw new Error("Choose a .sql file.");
  }
  if (file.size > MAX_SQL_FILE_SIZE) {
    throw new Error("SQL files must be 5 MB or smaller.");
  }
  return file.text();
}
