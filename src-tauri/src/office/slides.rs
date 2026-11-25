//! PowerPoint and LibreOffice presentations as slides of words and pictures. Shapes, places on
//! the slide and animations are left out: each slide shows its title, its lines in order, its
//! pictures and its speaker notes.

use serde::Serialize;

use super::{attribute, relation, walk, Doc, Node, Package, Reading};

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Line {
    pub text: String,
    /// How far in a bullet sits, from 0.
    pub depth: u8,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Slide {
    pub title: String,
    pub lines: Vec<Line>,
    /// Parts inside the file, as `canvas[data-picture]` loads them.
    pub pictures: Vec<String>,
    pub notes: String,
    pub hidden: bool,
}

impl Slide {
    pub fn text(&self) -> String {
        let mut out = self.title.clone();
        for line in &self.lines {
            out.push('\n');
            out.push_str(&"  ".repeat(usize::from(line.depth)));
            out.push_str(&line.text);
        }
        if !self.notes.is_empty() {
            out.push_str("\n\n");
            out.push_str(&self.notes);
        }
        out
    }
}

pub(super) fn read(package: &mut Package) -> Result<Reading, String> {
    let presentation = package.text("ppt/presentation.xml").ok_or("It has no presentation part, so it may be damaged")?;
    let rels = package.rels("ppt/presentation.xml");
    let mut parts = Vec::new();
    walk(&presentation, |node| {
        if let Node::Open("sldId", start) = node {
            if let Some(target) = relation(start).and_then(|id| rels.get(&id)) {
                parts.push(target.part.clone());
            }
        }
    });
    let mut slides = Vec::new();
    for part in parts {
        let Some(xml) = package.text(&part) else { continue };
        let rels = package.rels(&part);
        let mut slide = slide(&xml, |id| rels.get(id).filter(|target| !target.external).map(|target| target.part.clone()));
        let notes = rels.values().find(|target| target.kind.ends_with("/notesSlide")).map(|target| target.part.clone());
        if let Some(xml) = notes.and_then(|part| package.text(&part)) {
            slide.notes = notes_text(&xml);
        }
        slides.push(slide);
    }
    Ok(Reading { doc: Doc::Slides { slides }, note: None })
}

/// One slide's words and pictures. `picture` finds a picture's part by its id.
fn slide(xml: &str, picture: impl Fn(&str) -> Option<String>) -> Slide {
    let mut slide = Slide::default();
    let mut title_shape = false;
    let mut line: Option<Line> = None;
    let mut in_text = false;
    let mut cell_row: Option<Vec<String>> = None;
    walk(xml, |node| match node {
        Node::Open("sld", start) => slide.hidden = attribute(start, "show").is_some_and(|show| show == "0" || show == "false"),
        Node::Open("sp", _) => title_shape = false,
        Node::Open("ph", start) => title_shape = attribute(start, "type").is_some_and(|kind| kind == "title" || kind == "ctrTitle"),
        Node::Open("p", _) => line = Some(Line::default()),
        Node::Open("pPr", start) => {
            if let Some(line) = line.as_mut() {
                line.depth = attribute(start, "lvl").and_then(|level| level.parse().ok()).unwrap_or(0).min(8);
            }
        }
        Node::Open("t", _) => in_text = true,
        Node::Close("t") => in_text = false,
        Node::Text(text) if in_text => {
            if let Some(line) = line.as_mut() {
                line.text.push_str(text);
            }
        }
        Node::Open("br", _) => {
            if let Some(line) = line.as_mut() {
                line.text.push('\n');
            }
        }
        Node::Close("p") => {
            if let Some(done) = line.take().filter(|done| !done.text.trim().is_empty()) {
                if let Some(cells) = cell_row.as_mut() {
                    cells.push(done.text);
                } else if title_shape {
                    if !slide.title.is_empty() {
                        slide.title.push(' ');
                    }
                    slide.title.push_str(done.text.trim());
                } else {
                    slide.lines.push(done);
                }
            }
        }
        Node::Open("tr", _) => cell_row = Some(Vec::new()),
        Node::Close("tr") => {
            if let Some(cells) = cell_row.take().filter(|cells| !cells.is_empty()) {
                slide.lines.push(Line { text: cells.join("  ·  "), depth: 0 });
            }
        }
        Node::Open("blip", start) => {
            if let Some(part) = attribute(start, "embed").and_then(|id| picture(&id)) {
                if !slide.pictures.contains(&part) {
                    slide.pictures.push(part);
                }
            }
        }
        _ => {}
    });
    slide
}

/// The speaker notes: the notes page's body text, not its slide picture or page number.
fn notes_text(xml: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let (mut body, mut in_text) = (false, false);
    let mut line = String::new();
    walk(xml, |node| match node {
        Node::Open("sp", _) => body = false,
        Node::Open("ph", start) => body = attribute(start, "type").is_some_and(|kind| kind == "body"),
        Node::Open("t", _) => in_text = body,
        Node::Close("t") => in_text = false,
        Node::Text(text) if in_text => line.push_str(text),
        Node::Close("p") if body => {
            lines.push(std::mem::take(&mut line));
        }
        _ => {}
    });
    lines.join("\n").trim().to_string()
}

/// A LibreOffice presentation: each page's title frame, its text boxes, pictures and notes.
pub(super) fn open_document(package: &mut Package) -> Result<Reading, String> {
    let xml = package.text("content.xml").ok_or("It has no content part, so it may be damaged")?;
    let mut slides = Vec::new();
    let mut slide: Option<Slide> = None;
    let (mut title_frame, mut in_notes) = (false, false);
    let mut depth = 0u8;
    let mut text: Option<String> = None;
    walk(&xml, |node| match node {
        Node::Open("page", _) => slide = Some(Slide::default()),
        Node::Close("page") => slides.extend(slide.take()),
        Node::Open("notes", _) => in_notes = true,
        Node::Close("notes") => in_notes = false,
        Node::Open("frame", start) => title_frame = attribute(start, "class").is_some_and(|class| class == "title"),
        Node::Open("list", _) => depth = depth.saturating_add(1),
        Node::Close("list") => depth = depth.saturating_sub(1),
        Node::Open("p" | "h", _) => text = Some(String::new()),
        Node::Text(piece) => {
            if let Some(text) = text.as_mut() {
                text.push_str(piece);
            }
        }
        Node::Open("s", _) => {
            if let Some(text) = text.as_mut() {
                text.push(' ');
            }
        }
        Node::Open("line-break", _) => {
            if let Some(text) = text.as_mut() {
                text.push('\n');
            }
        }
        Node::Close("p" | "h") => {
            let (Some(done), Some(slide)) = (text.take().filter(|done| !done.trim().is_empty()), slide.as_mut()) else { return };
            if in_notes {
                if !slide.notes.is_empty() {
                    slide.notes.push('\n');
                }
                slide.notes.push_str(&done);
            } else if title_frame {
                if !slide.title.is_empty() {
                    slide.title.push(' ');
                }
                slide.title.push_str(done.trim());
            } else {
                slide.lines.push(Line { text: done, depth: depth.saturating_sub(1) });
            }
        }
        Node::Open("image", start) if !in_notes => {
            if let (Some(slide), Some(part)) = (slide.as_mut(), attribute(start, "href").filter(|href| !href.contains(':'))) {
                if !slide.pictures.contains(&part) {
                    slide.pictures.push(part);
                }
            }
        }
        _ => {}
    });
    Ok(Reading { doc: Doc::Slides { slides }, note: None })
}

#[cfg(test)]
mod tests {
    use super::super::tests::package;
    use super::super::{read, Doc};

    #[test]
    fn reads_a_presentation_in_its_own_order() {
        let presentation = r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>"#;
        let rels = r#"<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>"#;
        let first = r#"<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Point</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Under</a:t></a:r></a:p><a:p/></p:txBody></p:sp>
<p:pic><p:blipFill><a:blip r:embed="rId7"/></p:blipFill></p:pic>
<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>"#;
        let first_rels = r#"<Relationships><Relationship Id="rId7" Type="image" Target="../media/image1.png"/><Relationship Id="rId9" Type="http://x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>"#;
        let notes = r#"<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hi</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"#;
        let second = r#"<p:sld xmlns:p="p" xmlns:a="a" show="0"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>First</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#;
        let path = package(
            "talk.pptx",
            &[
                ("ppt/presentation.xml", presentation.as_bytes()),
                ("ppt/_rels/presentation.xml.rels", rels.as_bytes()),
                ("ppt/slides/slide1.xml", first.as_bytes()),
                ("ppt/slides/_rels/slide1.xml.rels", first_rels.as_bytes()),
                ("ppt/notesSlides/notesSlide1.xml", notes.as_bytes()),
                ("ppt/slides/slide2.xml", second.as_bytes()),
            ],
        );
        let Doc::Slides { slides } = read(&path, None).unwrap().doc else { panic!("not slides") };
        assert_eq!(slides.len(), 2);
        assert_eq!((slides[0].title.as_str(), slides[0].hidden), ("First", true));
        let hello = &slides[1];
        assert_eq!(hello.title, "Hello");
        let lines: Vec<_> = hello.lines.iter().map(|line| (line.text.as_str(), line.depth)).collect();
        assert_eq!(lines, [("Point", 0), ("Under", 1), ("A  ·  B", 0)]);
        assert_eq!(hello.pictures, ["ppt/media/image1.png"]);
        assert_eq!(hello.notes, "Say hi");
    }

    #[test]
    fn reads_a_libreoffice_presentation() {
        let content = r#"<office:document-content xmlns:office="o" xmlns:draw="d" xmlns:text="t" xmlns:presentation="p" xmlns:xlink="x"><office:body><office:presentation>
<draw:page draw:name="One"><draw:frame presentation:class="title"><draw:text-box><text:p>Big idea</text:p></draw:text-box></draw:frame>
<draw:frame presentation:class="outline"><draw:text-box><text:list><text:list-item><text:p>First</text:p><text:list><text:list-item><text:p>Inner</text:p></text:list-item></text:list></text:list-item></text:list></draw:text-box></draw:frame>
<draw:frame><draw:image xlink:href="Pictures/p.png"/></draw:frame>
<presentation:notes><draw:page-thumbnail/><draw:frame><draw:text-box><text:p>Speak slowly</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>
</office:presentation></office:body></office:document-content>"#;
        let path = package("idea.odp", &[("content.xml", content.as_bytes())]);
        let Doc::Slides { slides } = read(&path, None).unwrap().doc else { panic!("not slides") };
        assert_eq!(slides.len(), 1);
        assert_eq!(slides[0].title, "Big idea");
        let lines: Vec<_> = slides[0].lines.iter().map(|line| (line.text.as_str(), line.depth)).collect();
        assert_eq!(lines, [("First", 0), ("Inner", 1)]);
        assert_eq!(slides[0].pictures, ["Pictures/p.png"]);
        assert_eq!(slides[0].notes, "Speak slowly");
    }
}
