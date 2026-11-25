//! Word documents and LibreOffice text documents as a page of plain HTML.

use std::collections::HashMap;

use super::{attribute, relation, switched_on, walk, Doc, Node, Package, Reading};
use crate::preview::escape;

/// A page longer than this is cut, so a huge document still opens at once.
const MOST_HTML: usize = 8 * 1024 * 1024;

/// What a paragraph's style says of it.
#[derive(Clone, Default)]
struct Style {
    /// 1 for Heading 1 and the Title, and so on.
    heading: Option<u8>,
}

/// A list's count at each depth, by the list's id, for numbered lists.
type Counts = HashMap<String, Vec<u32>>;

#[derive(Default)]
struct Paragraph {
    html: String,
    text: String,
    style: Option<String>,
    outline: Option<u8>,
    list: Option<(String, u8)>,
    page_after: bool,
    centered: bool,
}

/// A run's look: bold, italic, underline, struck through.
#[derive(Default)]
struct Look {
    bold: bool,
    italic: bool,
    underline: bool,
    struck: bool,
}

impl Look {
    fn wrap(&self, text: &str) -> String {
        let mut out = escape(text);
        for (on, tag) in [(self.struck, "s"), (self.underline, "u"), (self.italic, "i"), (self.bold, "b")] {
            if on {
                out = format!("<{tag}>{out}</{tag}>");
            }
        }
        out
    }
}

fn styles(package: &mut Package) -> HashMap<String, Style> {
    let mut found = HashMap::new();
    let Some(xml) = package.text("word/styles.xml") else { return found };
    let mut id: Option<String> = None;
    let mut style = Style::default();
    walk(&xml, |node| match node {
        Node::Open("style", start) => {
            id = attribute(start, "styleId");
            style = Style::default();
        }
        Node::Open("name", start) if id.is_some() => {
            let name = attribute(start, "val").unwrap_or_default().to_lowercase();
            if name == "title" {
                style.heading = Some(1);
            } else if let Some(level) = name.strip_prefix("heading ").and_then(|level| level.parse::<u8>().ok()) {
                style.heading = Some(level.clamp(1, 6));
            }
        }
        Node::Open("outlineLvl", start) if id.is_some() => {
            if let Some(level) = attribute(start, "val").and_then(|level| level.parse::<u8>().ok()).filter(|level| *level < 9) {
                style.heading.get_or_insert((level + 1).min(6));
            }
        }
        Node::Close("style") => {
            if let Some(id) = id.take() {
                found.insert(id, style.clone());
            }
        }
        _ => {}
    });
    found
}

/// Which lists count with numbers, by list id and depth. The rest have bullets.
fn numbered(package: &mut Package) -> HashMap<(String, u8), bool> {
    let mut found = HashMap::new();
    let Some(xml) = package.text("word/numbering.xml") else { return found };
    let mut abstracts: HashMap<String, HashMap<u8, bool>> = HashMap::new();
    let mut lists: Vec<(String, String)> = Vec::new();
    let (mut abstract_id, mut level, mut list_id) = (None::<String>, 0u8, None::<String>);
    walk(&xml, |node| match node {
        Node::Open("abstractNum", start) => abstract_id = attribute(start, "abstractNumId"),
        Node::Open("lvl", start) => level = attribute(start, "ilvl").and_then(|level| level.parse().ok()).unwrap_or(0),
        Node::Open("numFmt", start) => {
            if let Some(id) = &abstract_id {
                let counts = attribute(start, "val").is_some_and(|format| format != "bullet" && format != "none");
                abstracts.entry(id.clone()).or_default().insert(level, counts);
            }
        }
        Node::Close("abstractNum") => abstract_id = None,
        Node::Open("num", start) => list_id = attribute(start, "numId"),
        Node::Open("abstractNumId", start) => {
            if let (Some(list), Some(of)) = (&list_id, attribute(start, "val")) {
                lists.push((list.clone(), of));
            }
        }
        _ => {}
    });
    for (list, of) in lists {
        for (level, counts) in abstracts.get(&of).into_iter().flatten() {
            found.insert((list.clone(), *level), *counts);
        }
    }
    found
}

pub(super) fn read(package: &mut Package) -> Result<Reading, String> {
    let xml = package.text("word/document.xml").ok_or("It has no document part, so it may be damaged")?;
    let styles = styles(package);
    let numbered = numbered(package);
    let rels = package.rels("word/document.xml");
    let mut page = Page::default();
    let mut counts = Counts::new();
    // Paragraphs inside a text box open while their paragraph is still going; they show after it.
    let mut paragraphs: Vec<Paragraph> = Vec::new();
    let mut boxed = String::new();
    let mut look = Look::default();
    let (mut in_run_look, mut in_text, mut in_paragraph_look) = (false, false, false);
    let mut links = 0usize;
    walk(&xml, |node| {
        match node {
            Node::Open("p", _) => paragraphs.push(Paragraph::default()),
            Node::Open("pPr", _) => in_paragraph_look = true,
            Node::Close("pPr") => in_paragraph_look = false,
            Node::Open("pStyle", start) if in_paragraph_look => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    paragraph.style = attribute(start, "val");
                }
            }
            Node::Open("outlineLvl", start) if in_paragraph_look => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    paragraph.outline = attribute(start, "val").and_then(|level| level.parse::<u8>().ok()).filter(|level| *level < 9).map(|level| (level + 1).min(6));
                }
            }
            Node::Open("jc", start) if in_paragraph_look => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    paragraph.centered = attribute(start, "val").is_some_and(|align| align == "center");
                }
            }
            Node::Open("ilvl", start) if in_paragraph_look => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    let level = attribute(start, "val").and_then(|level| level.parse().ok()).unwrap_or(0);
                    let id = paragraph.list.take().map(|(id, _)| id).unwrap_or_default();
                    paragraph.list = Some((id, level));
                }
            }
            Node::Open("numId", start) if in_paragraph_look => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    let id = attribute(start, "val").unwrap_or_default();
                    let level = paragraph.list.take().map_or(0, |(_, level)| level);
                    // List 0 means "no list" in Word.
                    paragraph.list = (id != "0").then_some((id, level));
                }
            }
            Node::Open("r", _) => look = Look::default(),
            Node::Open("rPr", _) => in_run_look = true,
            Node::Close("rPr") => in_run_look = false,
            Node::Open("b", start) if in_run_look => look.bold = switched_on(start),
            Node::Open("i", start) if in_run_look => look.italic = switched_on(start),
            Node::Open("strike" | "dstrike", start) if in_run_look => look.struck = switched_on(start),
            Node::Open("u", start) if in_run_look => look.underline = switched_on(start),
            Node::Open("t", _) => in_text = true,
            Node::Close("t") => in_text = false,
            Node::Text(text) if in_text => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    paragraph.html.push_str(&look.wrap(text));
                    paragraph.text.push_str(text);
                }
            }
            Node::Open("tab", _) if !in_paragraph_look => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    paragraph.html.push_str("<span class=\"office-tab\"></span>");
                    paragraph.text.push('\t');
                }
            }
            Node::Open("br", start) => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    if attribute(start, "type").is_some_and(|kind| kind == "page") {
                        paragraph.page_after = true;
                    } else {
                        paragraph.html.push_str("<br>");
                        paragraph.text.push('\n');
                    }
                }
            }
            Node::Open("hyperlink", start) => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    let target = relation(start).and_then(|id| rels.get(&id)).filter(|target| target.external).map(|target| target.part.clone());
                    let anchor = attribute(start, "anchor");
                    let tip = target.or(anchor.map(|anchor| format!("Goes to “{anchor}” in this document"))).unwrap_or_default();
                    paragraph.html.push_str(&format!("<span class=\"office-link\" data-tip=\"{}\">", escape(&tip)));
                    links += 1;
                }
            }
            Node::Close("hyperlink") => {
                if let Some(paragraph) = paragraphs.last_mut() {
                    if links > 0 {
                        paragraph.html.push_str("</span>");
                        links -= 1;
                    }
                }
            }
            // A picture: DrawingML names it by `embed`, old VML pictures by `id`.
            Node::Open("blip", start) | Node::Open("imagedata", start) => {
                let id = attribute(start, "embed").or_else(|| relation(start));
                if let (Some(paragraph), Some(target)) = (paragraphs.last_mut(), id.and_then(|id| rels.get(&id))) {
                    if !target.external {
                        paragraph.html.push_str(&picture(&target.part, "Picture"));
                    }
                }
            }
            Node::Close("p") => {
                if let Some(paragraph) = paragraphs.pop() {
                    let html = paragraph_html(paragraph, &styles, &numbered, &mut counts, &mut page.text);
                    if paragraphs.is_empty() {
                        page.push(&html);
                        page.push(&std::mem::take(&mut boxed));
                    } else {
                        boxed.push_str(&html);
                    }
                }
            }
            Node::Open("tbl", _) => page.push("<table class=\"office-table\">"),
            Node::Close("tbl") => page.push("</table>"),
            Node::Open("tr", _) => page.push("<tr>"),
            Node::Close("tr") => {
                page.push("</tr>");
                page.text.push('\n');
            }
            Node::Open("tc", _) => page.push("<td>"),
            Node::Close("tc") => {
                page.push("</td>");
                page.text.push('\t');
            }
            _ => {}
        }
    });
    Ok(page.done())
}

/// The page as it grows, and its plain text.
#[derive(Default)]
struct Page {
    html: String,
    text: String,
    cut: bool,
}

impl Page {
    fn push(&mut self, html: &str) {
        if self.html.len() + html.len() > super::word::MOST_HTML {
            self.cut = true;
        } else {
            self.html.push_str(html);
        }
    }

    fn done(self) -> Reading {
        let note = self.cut.then(|| "Only the start of this long document shows here.".to_string());
        Reading { doc: Doc::Word { html: self.html, text: self.text.trim_end().to_string() }, note }
    }
}

fn picture(part: &str, label: &str) -> String {
    format!(r#"<canvas class="md-picture" data-picture="{}" aria-label="{}"></canvas>"#, escape(part), escape(label))
}

fn paragraph_html(
    paragraph: Paragraph,
    styles: &HashMap<String, Style>,
    numbered: &HashMap<(String, u8), bool>,
    counts: &mut Counts,
    text: &mut String,
) -> String {
    let heading = paragraph.outline.or_else(|| paragraph.style.as_ref().and_then(|style| styles.get(style)).and_then(|style| style.heading));
    text.push_str(&paragraph.text);
    text.push('\n');
    let centered = if paragraph.centered { " class=\"office-center\"" } else { "" };
    let mut html = if let Some(level) = heading.filter(|_| !paragraph.text.trim().is_empty()) {
        format!("<h{level}{centered}>{}</h{level}>", paragraph.html)
    } else if let Some((id, level)) = paragraph.list {
        let marker = if numbered.get(&(id.clone(), level)).copied().unwrap_or(false) {
            let levels = counts.entry(id).or_default();
            levels.resize(usize::from(level) + 1, 0);
            levels[usize::from(level)] += 1;
            format!("{}.", levels[usize::from(level)])
        } else {
            "•".to_string()
        };
        format!("<p class=\"office-item\" style=\"--depth:{level}\"><span class=\"office-marker\">{marker}</span>{}</p>", paragraph.html)
    } else if paragraph.html.is_empty() {
        "<p class=\"office-gap\"></p>".to_string()
    } else {
        format!("<p{centered}>{}</p>", paragraph.html)
    };
    if paragraph.page_after {
        html.push_str("<hr class=\"office-page\">");
    }
    html
}

/// A LibreOffice text document: headings, paragraphs, lists, tables and pictures. Character
/// looks live in styles there, so text shows plain.
pub(super) fn open_document(package: &mut Package) -> Result<Reading, String> {
    let xml = package.text("content.xml").ok_or("It has no content part, so it may be damaged")?;
    let mut page = Page::default();
    let mut open: Vec<(String, String)> = Vec::new();
    let mut depth = 0u8;
    // Footnotes and the like sit inside a paragraph; their text is left out.
    let mut skipping = 0usize;
    walk(&xml, |node| {
        if skipping > 0 {
            match node {
                Node::Open("note" | "annotation" | "tracked-changes", _) => skipping += 1,
                Node::Close("note" | "annotation" | "tracked-changes") => skipping -= 1,
                _ => {}
            }
            return;
        }
        match node {
            Node::Open("note" | "annotation" | "tracked-changes", _) => skipping = 1,
            Node::Open("h", start) => {
                let level = attribute(start, "outline-level").and_then(|level| level.parse::<u8>().ok()).unwrap_or(1).clamp(1, 6);
                open.push((format!("h{level}"), String::new()));
            }
            Node::Open("p", _) => open.push(("p".into(), String::new())),
            Node::Text(text) => {
                if let Some((_, html)) = open.last_mut() {
                    html.push_str(&escape(text));
                    page.text.push_str(text);
                }
            }
            Node::Open("s", start) => {
                let count = attribute(start, "c").and_then(|count| count.parse::<usize>().ok()).unwrap_or(1).min(64);
                if let Some((_, html)) = open.last_mut() {
                    html.push_str(&" ".repeat(count));
                    page.text.push_str(&" ".repeat(count));
                }
            }
            Node::Open("tab", _) => {
                if let Some((_, html)) = open.last_mut() {
                    html.push_str("<span class=\"office-tab\"></span>");
                    page.text.push('\t');
                }
            }
            Node::Open("line-break", _) => {
                if let Some((_, html)) = open.last_mut() {
                    html.push_str("<br>");
                    page.text.push('\n');
                }
            }
            Node::Open("image", start) => {
                if let Some(part) = attribute(start, "href").filter(|href| !href.contains(':')) {
                    let html = picture(&part, "Picture");
                    match open.last_mut() {
                        Some((_, inner)) => inner.push_str(&html),
                        None => page.push(&html),
                    }
                }
            }
            Node::Close(tag @ ("h" | "p")) => {
                if let Some((name, html)) = open.pop() {
                    let made = if tag == "p" && depth > 0 {
                        format!("<p class=\"office-item\" style=\"--depth:{}\"><span class=\"office-marker\">•</span>{html}</p>", depth - 1)
                    } else if html.is_empty() {
                        "<p class=\"office-gap\"></p>".to_string()
                    } else {
                        format!("<{name}>{html}</{name}>")
                    };
                    match open.last_mut() {
                        Some((_, outer)) => outer.push_str(&made),
                        None => page.push(&made),
                    }
                    page.text.push('\n');
                }
            }
            Node::Open("list", _) => depth = depth.saturating_add(1),
            Node::Close("list") => depth = depth.saturating_sub(1),
            Node::Open("table", _) => page.push("<table class=\"office-table\">"),
            Node::Close("table") => page.push("</table>"),
            Node::Open("table-row", _) => page.push("<tr>"),
            Node::Close("table-row") => {
                page.push("</tr>");
                page.text.push('\n');
            }
            Node::Open("table-cell", _) => page.push("<td>"),
            Node::Close("table-cell") => {
                page.push("</td>");
                page.text.push('\t');
            }
            Node::Open("soft-page-break", _) if open.is_empty() => page.push("<hr class=\"office-page\">"),
            _ => {}
        }
    });
    Ok(page.done())
}

#[cfg(test)]
mod tests {
    use super::super::tests::package;
    use super::super::{read, Doc};

    const DOCUMENT: &str = r#"<w:document xmlns:w="w" xmlns:r="r" xmlns:a="a"><w:body>
<w:p><w:pPr><w:pStyle w:val="Kop1"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> and plain &amp; more</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>One</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Two</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rId9"><w:r><w:t>site</w:t></w:r></w:hyperlink><w:r><w:br w:type="page"/></w:r></w:p>
<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Not bold</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>
</w:body></w:document>"#;
    const STYLES: &str = r#"<w:styles xmlns:w="w"><w:style w:styleId="Kop1"><w:name w:val="heading 1"/></w:style></w:styles>"#;
    const NUMBERING: &str = r#"<w:numbering xmlns:w="w"><w:abstractNum w:abstractNumId="4"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="4"/></w:num></w:numbering>"#;
    const RELS: &str = r#"<Relationships><Relationship Id="rId5" Type="image" Target="media/image1.png"/><Relationship Id="rId9" Type="hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>"#;

    #[test]
    fn reads_a_word_document() {
        let path = package(
            "plan.docx",
            &[
                ("word/document.xml", DOCUMENT.as_bytes()),
                ("word/styles.xml", STYLES.as_bytes()),
                ("word/numbering.xml", NUMBERING.as_bytes()),
                ("word/_rels/document.xml.rels", RELS.as_bytes()),
            ],
        );
        let Doc::Word { html, text } = read(&path, None).unwrap().doc else { panic!("not a word document") };
        assert!(html.starts_with("<h1>Plan</h1>"), "{html}");
        assert!(html.contains("<p><b>Bold</b> and plain &amp; more</p>"), "{html}");
        assert!(html.contains(r#"<span class="office-marker">1.</span>One"#) && html.contains(r#"<span class="office-marker">2.</span>Two"#), "{html}");
        assert!(html.contains(r#"<span class="office-link" data-tip="https://example.com/">site</span>"#), "{html}");
        assert!(html.contains(r#"<hr class="office-page">"#), "{html}");
        assert!(html.contains(r#"data-picture="word/media/image1.png""#), "{html}");
        assert!(html.contains("<table class=\"office-table\"><tr><td><p>A1</p></td><td><p>B1</p></td></tr></table>"), "{html}");
        assert!(html.contains("<p>Not bold</p>") && !html.contains("gone"), "{html}");
        assert!(text.starts_with("Plan\nBold and plain & more\nOne\nTwo\nsite\n"), "{text}");
        assert!(text.contains("A1\n\tB1\n\t\n"), "{text:?}");
    }

    #[test]
    fn reads_a_libreoffice_text() {
        let content = r#"<office:document-content xmlns:office="o" xmlns:text="t" xmlns:draw="d" xmlns:xlink="x"><office:body><office:text>
<text:h text:outline-level="2">Part</text:h><text:p>Hello<text:s text:c="2"/>world<text:note><text:note-body><text:p>foot</text:p></text:note-body></text:note></text:p>
<text:list><text:list-item><text:p>Item</text:p></text:list-item></text:list>
<draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame>
</office:text></office:body></office:document-content>"#;
        let path = package("part.odt", &[("content.xml", content.as_bytes())]);
        let Doc::Word { html, text } = read(&path, None).unwrap().doc else { panic!("not a text document") };
        assert!(html.contains("<h2>Part</h2><p>Hello  world</p>"), "{html}");
        assert!(!html.contains("foot"), "{html}");
        assert!(html.contains(r#"style="--depth:0"><span class="office-marker">•</span>Item"#), "{html}");
        assert!(html.contains(r#"data-picture="Pictures/a.png""#), "{html}");
        assert!(text.contains("Hello  world"), "{text}");
    }
}
