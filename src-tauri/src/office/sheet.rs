//! Excel workbooks and LibreOffice spreadsheets as grids of values. A formula shows the value
//! it last worked out, as saved in the file; nothing is worked out again.

use std::collections::HashMap;

use serde::Serialize;

use super::{attribute, relation, walk, Doc, Node, Package, Reading};

/// The most rows and columns of each sheet that show.
pub(crate) const MOST_ROWS: usize = 5000;
pub(crate) const MOST_COLUMNS: usize = 200;

/// A cell as the grid shows it: a number sorts as one.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Cell {
    Text(String),
    Number(f64),
    Empty(Option<()>),
}

impl Cell {
    pub(crate) fn is_empty(&self) -> bool {
        matches!(self, Cell::Empty(_)) || matches!(self, Cell::Text(text) if text.is_empty())
    }

    fn shown(&self) -> String {
        match self {
            Cell::Text(text) => text.clone(),
            Cell::Number(number) => number.to_string(),
            Cell::Empty(_) => String::new(),
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    pub name: String,
    pub hidden: bool,
    /// From the first row down, each as wide as the widest, empty cells as null.
    pub rows: Vec<Vec<Cell>>,
    /// How many rows and columns the sheet has, past what shows.
    pub total_rows: usize,
    pub total_columns: usize,
}

impl Sheet {
    pub fn text(&self) -> String {
        let rows: Vec<String> = self.rows.iter().map(|row| row.iter().map(Cell::shown).collect::<Vec<_>>().join("\t").trim_end().to_string()).collect();
        format!("{}\n{}", self.name, rows.join("\n").trim_end())
    }
}

/// Cells as they come, by row and column from 0, cut to what shows.
#[derive(Default)]
pub(crate) struct Grid {
    cells: HashMap<(usize, usize), Cell>,
    rows: usize,
    columns: usize,
}

impl Grid {
    pub(crate) fn put(&mut self, row: usize, column: usize, cell: Cell) {
        if cell.is_empty() {
            return;
        }
        self.rows = self.rows.max(row + 1);
        self.columns = self.columns.max(column + 1);
        if row < MOST_ROWS && column < MOST_COLUMNS {
            self.cells.insert((row, column), cell);
        }
    }

    pub(crate) fn sheet(mut self, name: String, hidden: bool) -> Sheet {
        let (rows, columns) = (self.rows.min(MOST_ROWS), self.columns.min(MOST_COLUMNS));
        let rows = (0..rows).map(|row| (0..columns).map(|column| self.cells.remove(&(row, column)).unwrap_or(Cell::Empty(None))).collect()).collect();
        Sheet { name, hidden, rows, total_rows: self.rows, total_columns: self.columns }
    }
}

/// What is left out of a workbook whose sheets are bigger than what shows.
pub(crate) fn note_of(sheets: &[Sheet]) -> Option<String> {
    sheets
        .iter()
        .any(|sheet| sheet.total_rows > MOST_ROWS || sheet.total_columns > MOST_COLUMNS)
        .then(|| format!("Big sheets show their first {} rows and {} columns.", super::group(MOST_ROWS as u64), MOST_COLUMNS))
}

/// "B12" as row 11 and column 1.
fn place(reference: &str) -> Option<(usize, usize)> {
    let letters = reference.bytes().take_while(u8::is_ascii_alphabetic).count();
    let column = reference[..letters].bytes().try_fold(0usize, |sum, letter| sum.checked_mul(26)?.checked_add(usize::from(letter.to_ascii_uppercase() - b'A') + 1))?;
    let row: usize = reference[letters..].parse().ok()?;
    Some((row.checked_sub(1)?, column.checked_sub(1)?))
}

/// How a number in a cell is to be read, from its format.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Shape {
    Plain,
    Date,
    Percent,
}

/// What an Excel number format makes of a number. Built-in formats go by their id.
pub(crate) fn shape_of(id: u32, code: Option<&str>) -> Shape {
    match id {
        9 | 10 => return Shape::Percent,
        14..=22 | 27..=36 | 45..=47 | 50..=58 => return Shape::Date,
        _ => {}
    }
    let Some(code) = code else { return Shape::Plain };
    // Quoted text, escaped letters and colours in brackets don't count.
    let mut plain = String::new();
    let (mut quoted, mut bracket, mut escaped) = (false, false, false);
    for letter in code.chars() {
        match letter {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => quoted = !quoted,
            '[' if !quoted => bracket = true,
            ']' if !quoted => bracket = false,
            _ if quoted || bracket => {}
            letter => plain.push(letter.to_ascii_lowercase()),
        }
    }
    if plain.contains('%') {
        Shape::Percent
    } else if plain.chars().any(|letter| matches!(letter, 'y' | 'd' | 'h' | 's')) || (plain.contains('m') && !plain.contains('0') && !plain.contains('#')) {
        Shape::Date
    } else {
        Shape::Plain
    }
}

/// A serial day number as a date, and a time when it has one. Days count from the end of 1899,
/// or from 1904 in workbooks set that way.
pub(crate) fn date_text(serial: f64, from_1904: bool) -> String {
    if !serial.is_finite() || !(0.0..3_000_000.0).contains(&serial) {
        return serial.to_string();
    }
    let mut whole = serial.floor() as i64;
    let seconds = ((serial - serial.floor()) * 86_400.0).round() as i64;
    let (whole_days, seconds) = if seconds >= 86_400 { (whole + 1, 0) } else { (whole, seconds) };
    whole = whole_days;
    let time = format!("{:02}:{:02}", seconds / 3600, seconds / 60 % 60);
    if whole == 0 && !from_1904 {
        return time;
    }
    // Excel counts a 29 February 1900 that never was, so days after it are one too many.
    let days = if from_1904 { whole + 1461 } else if whole < 60 { whole } else { whole - 1 };
    let (year, month, day) = civil(days);
    let date = format!("{year:04}-{month:02}-{day:02}");
    if seconds > 0 { format!("{date} {time}") } else { date }
}

/// Days since 1900-01-01 (day 1) as a calendar date.
fn civil(days_from_1900: i64) -> (i64, u32, u32) {
    // Days from 1970-01-01, then Howard Hinnant's civil-from-days.
    let z = days_from_1900 - 25_568 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A number as a cell shows it, by its shape.
pub(crate) fn number_cell(number: f64, shape: Shape, from_1904: bool) -> Cell {
    match shape {
        Shape::Plain => Cell::Number(number),
        Shape::Date => Cell::Text(date_text(number, from_1904)),
        Shape::Percent => Cell::Text(format!("{}%", round(number * 100.0))),
    }
}

/// "2024-01-31T00:00:00" as "2024-01-31", and a time to the minute when it has one.
fn open_date(date: &str) -> String {
    match date.split_once('T') {
        Some((day, time)) if !time.starts_with("00:00:00") => format!("{day} {}", time.get(..5).unwrap_or(time)),
        Some((day, _)) => day.to_string(),
        None => date.to_string(),
    }
}

fn round(number: f64) -> String {
    let text = format!("{:.4}", number);
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn shared_strings(package: &mut Package) -> Vec<String> {
    let mut found = Vec::new();
    let Some(xml) = package.text("xl/sharedStrings.xml") else { return found };
    let (mut current, mut in_text, mut in_phonetic) = (String::new(), false, false);
    walk(&xml, |node| match node {
        Node::Open("si", _) => current.clear(),
        Node::Close("si") => found.push(std::mem::take(&mut current)),
        Node::Open("rPh", _) => in_phonetic = true,
        Node::Close("rPh") => in_phonetic = false,
        Node::Open("t", _) => in_text = !in_phonetic,
        Node::Close("t") => in_text = false,
        Node::Text(text) if in_text => current.push_str(text),
        _ => {}
    });
    found
}

/// Each cell style's shape, by its index.
fn shapes(package: &mut Package) -> Vec<Shape> {
    let mut found = Vec::new();
    let Some(xml) = package.text("xl/styles.xml") else { return found };
    let mut codes: HashMap<u32, String> = HashMap::new();
    let mut in_cell_styles = false;
    walk(&xml, |node| match node {
        Node::Open("numFmt", start) => {
            if let (Some(id), Some(code)) = (attribute(start, "numFmtId").and_then(|id| id.parse().ok()), attribute(start, "formatCode")) {
                codes.insert(id, code);
            }
        }
        Node::Open("cellXfs", _) => in_cell_styles = true,
        Node::Close("cellXfs") => in_cell_styles = false,
        Node::Open("xf", start) if in_cell_styles => {
            let id = attribute(start, "numFmtId").and_then(|id| id.parse().ok()).unwrap_or(0);
            found.push(shape_of(id, codes.get(&id).map(String::as_str)));
        }
        _ => {}
    });
    found
}

pub(super) fn read(package: &mut Package) -> Result<Reading, String> {
    let workbook = package.text("xl/workbook.xml").ok_or("It has no workbook part, so it may be damaged")?;
    let rels = package.rels("xl/workbook.xml");
    let strings = shared_strings(package);
    let shapes = shapes(package);
    let mut listed: Vec<(String, bool, String)> = Vec::new();
    let mut from_1904 = false;
    walk(&workbook, |node| match node {
        Node::Open("workbookPr", start) => from_1904 = attribute(start, "date1904").is_some_and(|on| on == "1" || on == "true"),
        Node::Open("sheet", start) => {
            let name = attribute(start, "name").unwrap_or_default();
            let hidden = attribute(start, "state").is_some_and(|state| state != "visible");
            if let Some(target) = relation(start).and_then(|id| rels.get(&id)) {
                listed.push((name, hidden, target.part.clone()));
            }
        }
        _ => {}
    });
    let mut sheets = Vec::new();
    for (name, hidden, part) in listed {
        // A chart sheet has no cells; it shows as an empty sheet.
        let grid = package.text(&part).map(|xml| worksheet(&xml, &strings, &shapes, from_1904)).unwrap_or_default();
        sheets.push(grid.sheet(name, hidden));
    }
    let note = note_of(&sheets);
    Ok(Reading { doc: Doc::Sheet { sheets }, note })
}

fn worksheet(xml: &str, strings: &[String], shapes: &[Shape], from_1904: bool) -> Grid {
    let mut grid = Grid::default();
    let (mut row, mut column) = (0usize, 0usize);
    let (mut kind, mut style) = (String::new(), 0usize);
    let (mut value, mut in_value, mut in_inline) = (String::new(), false, false);
    walk(xml, |node| match node {
        Node::Open("row", start) => {
            if let Some(number) = attribute(start, "r").and_then(|number| number.parse::<usize>().ok()) {
                row = number.saturating_sub(1);
            }
            column = 0;
        }
        Node::Close("row") => row += 1,
        Node::Open("c", start) => {
            if let Some((at_row, at_column)) = attribute(start, "r").and_then(|reference| place(&reference)) {
                (row, column) = (at_row, at_column);
            }
            kind = attribute(start, "t").unwrap_or_default();
            style = attribute(start, "s").and_then(|style| style.parse().ok()).unwrap_or(0);
            value.clear();
        }
        Node::Close("c") => {
            let cell = match kind.as_str() {
                "s" => Cell::Text(value.trim().parse::<usize>().ok().and_then(|at| strings.get(at)).cloned().unwrap_or_default()),
                "str" | "inlineStr" | "e" => Cell::Text(std::mem::take(&mut value)),
                "b" => Cell::Text(if value.trim() == "1" { "TRUE" } else { "FALSE" }.into()),
                _ => match value.trim().parse::<f64>() {
                    Ok(number) => number_cell(number, shapes.get(style).copied().unwrap_or(Shape::Plain), from_1904),
                    Err(_) => Cell::Text(std::mem::take(&mut value)),
                },
            };
            grid.put(row, column, cell);
            column += 1;
        }
        Node::Open("v", _) => in_value = true,
        Node::Close("v") => in_value = false,
        Node::Open("is", _) => in_inline = true,
        Node::Close("is") => in_inline = false,
        Node::Text(text) if in_value || in_inline => value.push_str(text),
        _ => {}
    });
    grid
}

/// A LibreOffice spreadsheet. Its rows and cells say how many times they repeat, so a run of
/// empty cells at the end of a row, which may be a million long, is never filled in.
pub(super) fn open_document(package: &mut Package) -> Result<Reading, String> {
    let xml = package.text("content.xml").ok_or("It has no content part, so it may be damaged")?;
    let mut sheets = Vec::new();
    let mut grid: Option<(String, bool, Grid)> = None;
    let (mut row, mut column) = (0usize, 0usize);
    let (mut row_repeat, mut cell_repeat) = (1usize, 1usize);
    let mut cell: Option<Cell> = None;
    let mut text = String::new();
    let mut in_text = 0usize;
    walk(&xml, |node| match node {
        Node::Open("table", start) => {
            let name = attribute(start, "name").unwrap_or_default();
            let hidden = attribute(start, "display").is_some_and(|display| display == "false");
            grid = Some((name, hidden, Grid::default()));
            row = 0;
        }
        Node::Close("table") => {
            if let Some((name, hidden, grid)) = grid.take() {
                sheets.push(grid.sheet(name, hidden));
            }
        }
        Node::Open("table-row", start) => {
            row_repeat = attribute(start, "number-rows-repeated").and_then(|count| count.parse().ok()).unwrap_or(1).max(1);
            column = 0;
        }
        Node::Close("table-row") => row = row.saturating_add(row_repeat),
        Node::Open("table-cell" | "covered-table-cell", start) => {
            cell_repeat = attribute(start, "number-columns-repeated").and_then(|count| count.parse().ok()).unwrap_or(1).max(1);
            let kind = attribute(start, "value-type").unwrap_or_default();
            cell = match kind.as_str() {
                "float" | "currency" => attribute(start, "value").and_then(|value| value.parse().ok()).map(Cell::Number),
                "percentage" => attribute(start, "value").and_then(|value| value.parse::<f64>().ok()).map(|value| number_cell(value, Shape::Percent, false)),
                "date" => attribute(start, "date-value").map(|date| Cell::Text(open_date(&date))),
                "boolean" => attribute(start, "boolean-value").map(|on| Cell::Text(if on == "true" { "TRUE" } else { "FALSE" }.into())),
                _ => None,
            };
            text.clear();
        }
        Node::Close("table-cell" | "covered-table-cell") => {
            let made = cell.take().unwrap_or_else(|| Cell::Text(text.trim_end().to_string()));
            if let Some((_, _, grid)) = grid.as_mut() {
                // Repeats of an empty cell are only room; a filled one repeats as itself, up to what shows.
                if !made.is_empty() {
                    for one_row in 0..row_repeat.min(MOST_ROWS) {
                        for one_column in 0..cell_repeat.min(MOST_COLUMNS) {
                            grid.put(row.saturating_add(one_row), column.saturating_add(one_column), made.clone());
                        }
                    }
                }
            }
            column = column.saturating_add(cell_repeat);
        }
        Node::Open("p", _) => {
            if in_text == 0 && !text.is_empty() {
                text.push('\n');
            }
            in_text += 1;
        }
        Node::Close("p") => in_text = in_text.saturating_sub(1),
        Node::Open("s", _) if in_text > 0 => text.push(' '),
        Node::Text(piece) if in_text > 0 => text.push_str(piece),
        _ => {}
    });
    let note = note_of(&sheets);
    Ok(Reading { doc: Doc::Sheet { sheets }, note })
}

#[cfg(test)]
mod tests {
    use super::super::tests::package;
    use super::super::{read, Doc};
    use super::*;

    #[test]
    fn places_cells_by_their_reference() {
        assert_eq!(place("A1"), Some((0, 0)));
        assert_eq!(place("B12"), Some((11, 1)));
        assert_eq!(place("AA3"), Some((2, 26)));
        assert_eq!(place("A0"), None);
    }

    #[test]
    fn reads_number_formats() {
        assert_eq!(shape_of(14, None), Shape::Date);
        assert_eq!(shape_of(10, None), Shape::Percent);
        assert_eq!(shape_of(164, Some("yyyy\\-mm\\-dd")), Shape::Date);
        assert_eq!(shape_of(165, Some("#,##0.00\" days\"")), Shape::Plain);
        assert_eq!(shape_of(166, Some("[Red]0.0%")), Shape::Percent);
        assert_eq!(shape_of(167, Some("[h]:mm")), Shape::Date);
        assert_eq!(shape_of(2, None), Shape::Plain);
    }

    #[test]
    fn reads_serial_dates() {
        assert_eq!(date_text(1.0, false), "1900-01-01");
        assert_eq!(date_text(59.0, false), "1900-02-28");
        assert_eq!(date_text(61.0, false), "1900-03-01");
        assert_eq!(date_text(45_292.0, false), "2024-01-01");
        assert_eq!(date_text(45_292.5, false), "2024-01-01 12:00");
        assert_eq!(date_text(0.25, false), "06:00");
        assert_eq!(date_text(0.0, true), "1904-01-01");
    }

    #[test]
    fn reads_an_excel_workbook() {
        let workbook = r#"<workbook xmlns:r="r"><sheets><sheet name="Money" sheetId="1" r:id="rId1"/><sheet name="Secret" state="hidden" sheetId="2" r:id="rId2"/></sheets></workbook>"#;
        let rels = r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#;
        let strings = r#"<sst><si><t>Item</t></si><si><r><t>Pr</t></r><r><t>ice</t></r><rPh><t>x</t></rPh></si></sst>"#;
        let styles = r#"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="d/m/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="9"/></cellXfs></styleSheet>"#;
        let sheet = r#"<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Tea</t></is></c><c r="B2"><f>1+1</f><v>2.5</v></c><c r="C2" s="1"><v>45292</v></c><c r="D2" s="2"><v>0.125</v></c><c r="E2" t="b"><v>1</v></c></row>
<row r="4"><c r="B4"><v>7</v></c></row>
</sheetData></worksheet>"#;
        let path = package(
            "money.xlsx",
            &[
                ("xl/workbook.xml", workbook.as_bytes()),
                ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
                ("xl/sharedStrings.xml", strings.as_bytes()),
                ("xl/styles.xml", styles.as_bytes()),
                ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
                ("xl/worksheets/sheet2.xml", b"<worksheet><sheetData/></worksheet>"),
            ],
        );
        let Doc::Sheet { sheets } = read(&path, None).unwrap().doc else { panic!("not a workbook") };
        assert_eq!(sheets.len(), 2);
        assert_eq!((sheets[0].name.as_str(), sheets[0].hidden, sheets[1].hidden), ("Money", false, true));
        let text = |cell: &Cell| cell.shown();
        let rows: Vec<Vec<String>> = sheets[0].rows.iter().map(|row| row.iter().map(text).collect()).collect();
        assert_eq!(rows[0], ["Item", "Price", "", "", ""]);
        assert_eq!(rows[1], ["Tea", "2.5", "2024-01-01", "12.5%", "TRUE"]);
        assert_eq!(rows[2], ["", "", "", "", ""]);
        assert_eq!(rows[3], ["", "7", "", "", ""]);
        assert_eq!(sheets[0].rows[1][1], Cell::Number(2.5));
    }

    #[test]
    fn reads_a_libreoffice_sheet_without_filling_repeats() {
        let content = r#"<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet>
<table:table table:name="Plan"><table:table-row><table:table-cell office:value-type="string"><text:p>Name</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16384"/></table:table-row>
<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2" office:value-type="percentage" office:value="0.5"/></table:table-row>
<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>"#;
        let path = package("plan.ods", &[("content.xml", content.as_bytes())]);
        let Doc::Sheet { sheets } = read(&path, None).unwrap().doc else { panic!("not a sheet") };
        let rows: Vec<Vec<String>> = sheets[0].rows.iter().map(|row| row.iter().map(Cell::shown).collect()).collect();
        assert_eq!(rows, [vec!["Name", "3"], vec!["50%", "50%"], vec!["50%", "50%"]]);
        assert_eq!((sheets[0].total_rows, sheets[0].total_columns), (3, 2));
    }
}
