//! A SQLite database shown as tables, and nothing in it ever written. The file opens read-only
//! and `query_only`. With no write-ahead log beside it, it opens as immutable too, so not even the
//! `-wal` and `-shm` files SQLite keeps beside a database it reads are made in the user's folder.

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, ToSql};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

/// The rows a table or a query shows at most, as for a CSV file.
const MOST_ROWS: usize = 5000;
/// A longer text in one field is cut here, with an ellipsis.
const MOST_CHARS: usize = 4000;
/// A query that runs longer is stopped.
const MOST_SECONDS: u64 = if cfg!(test) { 1 } else { 10 };
/// Another app writing to the database gets this long to finish before a read gives up.
const BUSY_MS: u64 = 1000;
const HEADER: &[u8; 16] = b"SQLite format 3\0";

/// A SQLite database, by its first bytes, whatever its name.
pub fn is_database(path: &Path) -> bool {
    let mut start = [0; 16];
    File::open(path).and_then(|mut file| file.read_exact(&mut start)).is_ok() && &start == HEADER
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Table {
    pub name: String,
    pub view: bool,
    /// The statement that made it, as the database keeps it.
    pub sql: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Rows {
    pub columns: Vec<String>,
    /// Each column's declared type, where the database says one.
    pub types: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// There are more rows than `MOST_ROWS`.
    pub more: bool,
}

/// Which column, counted from 0, sorts the rows, and which way.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Order {
    pub column: usize,
    pub down: bool,
}

/// The URI SQLite opens the file by. `%`, `?` and `#` mean something in a URI, so they are
/// written out; a share's `\\server\share` keeps its two leading slashes as part of the path.
fn uri(path: &Path, immutable: bool) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut uri = String::from(if text.starts_with('/') { "file://" } else { "file:///" });
    for char in text.chars() {
        match char {
            '%' => uri.push_str("%25"),
            '?' => uri.push_str("%3f"),
            '#' => uri.push_str("%23"),
            _ => uri.push(char),
        }
    }
    uri.push_str("?mode=ro");
    if immutable {
        uri.push_str("&immutable=1");
    }
    uri
}

fn open(path: &Path) -> Result<Connection, String> {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    // A log beside it holds changes not yet in the file, which an immutable read would miss.
    let immutable = !Path::new(&wal).exists();
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(uri(path, immutable), flags).map_err(told)?;
    connection.pragma_update(None, "query_only", true).map_err(told)?;
    connection.busy_timeout(Duration::from_millis(BUSY_MS)).map_err(told)?;
    Ok(connection)
}

/// SQLite's words for what went wrong, said plainly where they're common.
fn told(error: rusqlite::Error) -> String {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::OperationInterrupted) => format!("This took longer than {MOST_SECONDS} seconds, so it stopped."),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => "Another app is using this database right now.".into(),
        Some(rusqlite::ErrorCode::NotADatabase) => "This file isn't a database Perli can read, or it's locked with a password.".into(),
        Some(rusqlite::ErrorCode::ReadOnly) => "Perli only reads databases, so this can't run here.".into(),
        _ => error.to_string(),
    }
}

/// Runs `work`, and stops SQLite if it is still at it after `MOST_SECONDS`.
fn in_time<T>(connection: &Connection, work: impl FnOnce() -> T) -> T {
    let interrupt = connection.get_interrupt_handle();
    let (done, waiting) = mpsc::channel::<()>();
    let timer = std::thread::spawn(move || {
        if waiting.recv_timeout(Duration::from_secs(MOST_SECONDS)) == Err(mpsc::RecvTimeoutError::Timeout) {
            interrupt.interrupt();
        }
    });
    let result = work();
    drop(done);
    let _ = timer.join();
    result
}

/// `"name"`, as SQL names a table or column whatever it holds.
fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The database's tables, then its views, by name.
pub fn tables(path: &Path) -> Result<Vec<Table>, String> {
    let connection = open(path)?;
    let mut statement = connection
        .prepare(
            "SELECT name, type = 'view', coalesce(sql, '') FROM sqlite_schema
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
             ORDER BY type = 'view', name COLLATE NOCASE",
        )
        .map_err(told)?;
    let found = statement.query_map([], |row| Ok(Table { name: row.get(0)?, view: row.get(1)?, sql: row.get(2)? })).map_err(told)?;
    found.collect::<Result<_, _>>().map_err(told)
}

/// How many rows a table or view holds.
pub fn count(path: &Path, table: &str) -> Result<u64, String> {
    let connection = open(path)?;
    let found: i64 = in_time(&connection, || connection.query_row(&format!("SELECT count(*) FROM {}", quoted(table)), [], |row| row.get(0))).map_err(told)?;
    Ok(found.max(0) as u64)
}

/// A field as the table shows it. A blob says what it is and how big.
fn field(value: ValueRef) -> Option<String> {
    Some(match value {
        ValueRef::Null => return None,
        ValueRef::Integer(number) => number.to_string(),
        ValueRef::Real(number) => number.to_string(),
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            match text.char_indices().nth(MOST_CHARS) {
                Some((cut, _)) => format!("{}…", &text[..cut]),
                None => text.into_owned(),
            }
        }
        ValueRef::Blob(bytes) => {
            let kind = match bytes {
                [0x89, b'P', b'N', b'G', ..] => "PNG picture",
                [0xFF, 0xD8, 0xFF, ..] => "JPEG picture",
                [b'G', b'I', b'F', b'8', ..] => "GIF picture",
                [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "WebP picture",
                _ => "Binary",
            };
            format!("[{kind}, {}]", bytes_text(bytes.len()))
        }
    })
}

fn bytes_text(bytes: usize) -> String {
    match bytes {
        0..1024 => format!("{bytes} bytes"),
        1024..1_048_576 => format!("{:.1} KB", bytes as f64 / 1024.0),
        _ => format!("{:.1} MB", bytes as f64 / 1_048_576.0),
    }
}

fn run(connection: &Connection, sql: &str, values: &[&dyn ToSql]) -> Result<Rows, String> {
    in_time(connection, || {
        let mut statement = connection.prepare(sql)?;
        let columns: Vec<String> = statement.column_names().map(String::from).collect();
        let width = columns.len();
        let mut found = statement.query(values)?;
        let mut rows = Vec::new();
        while let Some(row) = found.next()? {
            if rows.len() == MOST_ROWS {
                return Ok(Rows { columns, rows, more: true, ..Rows::default() });
            }
            rows.push((0..width).map(|at| row.get_ref(at).map(field)).collect::<Result<_, _>>()?);
        }
        Ok(Rows { columns, rows, ..Rows::default() })
    })
    .map_err(told)
}

/// A table's first rows, sorted by one column with empty fields last, and only those whose
/// fields hold each column's filter text, as SQLite's `LIKE` matches it.
pub fn rows(path: &Path, table: &str, order: Option<Order>, filters: &[String]) -> Result<Rows, String> {
    let connection = open(path)?;
    let named: Vec<(String, String)> = {
        let mut statement = connection.prepare("SELECT name, type FROM pragma_table_xinfo(?1) WHERE hidden <> 1").map_err(told)?;
        let found = statement.query_map([table], |row| Ok((row.get(0)?, row.get(1)?))).map_err(told)?;
        found.collect::<Result<_, _>>().map_err(told)?
    };
    let mut sql = format!("SELECT * FROM {}", quoted(table));
    let mut wanted = Vec::new();
    for (column, filter) in filters.iter().enumerate() {
        let (Some((name, _)), filter) = (named.get(column), filter.trim()) else { continue };
        if filter.is_empty() {
            continue;
        }
        sql.push_str(if wanted.is_empty() { " WHERE " } else { " AND " });
        sql.push_str(&format!("CAST({} AS TEXT) LIKE ? ESCAPE '\\'", quoted(name)));
        let escaped = filter.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        wanted.push(format!("%{escaped}%"));
    }
    if let Some((name, _)) = order.and_then(|order| named.get(order.column).map(|found| (found, order.down))) {
        let way = if order.is_some_and(|order| order.down) { " DESC" } else { "" };
        let name = quoted(&name.0);
        sql.push_str(&format!(" ORDER BY {name} IS NULL, {name} COLLATE NOCASE{way}"));
    }
    let values: Vec<&dyn ToSql> = wanted.iter().map(|value| value as &dyn ToSql).collect();
    let mut found = run(&connection, &sql, &values)?;
    if found.columns.len() == named.len() {
        found.types = named.into_iter().map(|(_, kind)| kind).collect();
    }
    Ok(found)
}

/// What the user's own statement finds. It can only read: the database is open read-only.
pub fn query(path: &Path, sql: &str) -> Result<Rows, String> {
    let connection = open(path)?;
    run(&connection, sql, &[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture(PathBuf);

    impl Fixture {
        /// A database with a table of people and a view, closed again so only reads follow.
        fn new(name: &str) -> Self {
            let folder = std::env::temp_dir().join(format!("perli-tables-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&folder);
            std::fs::create_dir_all(&folder).unwrap();
            let path = folder.join("people #1.db");
            let made = Connection::open(&path).unwrap();
            made.execute_batch(
                "CREATE TABLE people (name TEXT, age INTEGER, photo BLOB);
                 INSERT INTO people VALUES ('Ann', 31, x'89504E470D0A'), ('bob', NULL, NULL), ('Cy_d', 7, x'0001');
                 CREATE VIEW grown AS SELECT name FROM people WHERE age > 18;",
            )
            .unwrap();
            drop(made);
            Self(folder)
        }

        fn path(&self) -> PathBuf {
            self.0.join("people #1.db")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn names(rows: &Rows) -> Vec<Option<String>> {
        rows.rows.iter().map(|row| row[0].clone()).collect()
    }

    #[test]
    fn a_uri_writes_out_what_means_something_in_one() {
        assert_eq!(uri(Path::new(r"D:\a b\x#1%?.db"), true), "file:///D:/a b/x%231%25%3f.db?mode=ro&immutable=1");
        assert_eq!(uri(Path::new(r"\\server\share\a.db"), false), "file:////server/share/a.db?mode=ro");
    }

    #[test]
    fn tables_and_views_list_and_count_and_nothing_is_written_beside_the_file() {
        let fixture = Fixture::new("list");
        assert!(is_database(&fixture.path()));
        let found = tables(&fixture.path()).unwrap();
        assert_eq!(found.iter().map(|table| (table.name.as_str(), table.view)).collect::<Vec<_>>(), [("people", false), ("grown", true)]);
        assert_eq!(count(&fixture.path(), "people").unwrap(), 3);
        assert_eq!(count(&fixture.path(), "grown").unwrap(), 1);
        let beside: Vec<_> = std::fs::read_dir(&fixture.0).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(beside, ["people #1.db"]);
    }

    #[test]
    fn rows_sort_with_empty_last_and_filter_as_typed() {
        let fixture = Fixture::new("rows");
        let all = rows(&fixture.path(), "people", None, &[]).unwrap();
        assert_eq!(all.columns, ["name", "age", "photo"]);
        assert_eq!(all.types, ["TEXT", "INTEGER", "BLOB"]);
        assert_eq!(all.rows[0], [Some("Ann".into()), Some("31".into()), Some("[PNG picture, 6 bytes]".into())]);
        assert_eq!(all.rows[1][1], None);
        let by_age = rows(&fixture.path(), "people", Some(Order { column: 1, down: true }), &[]).unwrap();
        assert_eq!(names(&by_age), [Some("Ann".into()), Some("Cy_d".into()), Some("bob".into())]);
        let by_name = rows(&fixture.path(), "people", Some(Order { column: 0, down: false }), &[]).unwrap();
        assert_eq!(names(&by_name), [Some("Ann".into()), Some("bob".into()), Some("Cy_d".into())]);
        // `_` is a letter here, not LIKE's "any one letter".
        let typed = rows(&fixture.path(), "people", None, &["_".into()]).unwrap();
        assert_eq!(names(&typed), [Some("Cy_d".into())]);
        let numbers = rows(&fixture.path(), "people", None, &["".into(), "3".into()]).unwrap();
        assert_eq!(names(&numbers), [Some("Ann".into())]);
    }

    #[test]
    fn a_query_reads_but_never_writes() {
        let fixture = Fixture::new("query");
        let found = query(&fixture.path(), "SELECT upper(name) AS shout FROM people ORDER BY 1").unwrap();
        assert_eq!(found.columns, ["shout"]);
        assert_eq!(found.rows.len(), 3);
        assert!(query(&fixture.path(), "DELETE FROM people").is_err());
        let elsewhere = fixture.0.join("elsewhere.db").to_string_lossy().replace('\'', "''");
        assert!(query(&fixture.path(), &format!("ATTACH '{elsewhere}' AS other")).is_err());
        assert_eq!(count(&fixture.path(), "people").unwrap(), 3);
        assert!(!fixture.0.join("elsewhere.db").exists());
    }

    #[test]
    fn a_long_query_stops() {
        let fixture = Fixture::new("long");
        let endless = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n";
        assert!(query(&fixture.path(), endless).unwrap_err().contains("seconds"));
    }
}
