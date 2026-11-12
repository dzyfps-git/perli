/** A glyph a folder can wear, from Segoe Fluent Icons, with words to find it by. */
export interface FolderIcon {
  label: string;
  glyph: string;
  words: string;
}

export const FOLDER_ICONS: FolderIcon[] = [
  { label: "Star", glyph: "", words: "favorite important" },
  { label: "Heart", glyph: "", words: "love like" },
  { label: "Work", glyph: "", words: "briefcase job office business" },
  { label: "Code", glyph: "", words: "programming developer source" },
  { label: "Tools", glyph: "", words: "developer build" },
  { label: "Bug", glyph: "", words: "debug test" },
  { label: "Robot", glyph: "", words: "ai bot machine" },
  { label: "Music", glyph: "", words: "audio songs sound" },
  { label: "Headphones", glyph: "", words: "audio podcast listen" },
  { label: "Microphone", glyph: "", words: "voice record podcast" },
  { label: "Speaker", glyph: "", words: "audio sound volume" },
  { label: "Pictures", glyph: "", words: "photos images gallery" },
  { label: "Photo", glyph: "", words: "image picture" },
  { label: "Camera", glyph: "", words: "photos shoot" },
  { label: "Video", glyph: "", words: "film clips record" },
  { label: "Movies", glyph: "", words: "film cinema" },
  { label: "TV", glyph: "", words: "monitor screen shows" },
  { label: "Games", glyph: "", words: "controller play" },
  { label: "Puzzle", glyph: "", words: "game plugin extension" },
  { label: "Package", glyph: "", words: "box archive parcel" },
  { label: "Download", glyph: "", words: "get save incoming" },
  { label: "Upload", glyph: "", words: "send outgoing share" },
  { label: "Cloud", glyph: "", words: "online sync backup" },
  { label: "Sync", glyph: "", words: "refresh backup" },
  { label: "Document", glyph: "", words: "file paper text" },
  { label: "Library", glyph: "", words: "books reading" },
  { label: "Education", glyph: "", words: "school study university graduation" },
  { label: "Font", glyph: "", words: "type text letters" },
  { label: "Edit", glyph: "", words: "pen write draft" },
  { label: "Lightbulb", glyph: "", words: "idea ideas" },
  { label: "Calendar", glyph: "", words: "date plan schedule" },
  { label: "History", glyph: "", words: "time past old" },
  { label: "Clock", glyph: "", words: "time recent" },
  { label: "Flag", glyph: "", words: "mark report" },
  { label: "Pin", glyph: "", words: "keep stick" },
  { label: "Tag", glyph: "", words: "label" },
  { label: "Important", glyph: "", words: "alert attention" },
  { label: "Lock", glyph: "", words: "private secure secret" },
  { label: "Key", glyph: "", words: "password permissions" },
  { label: "Shield", glyph: "", words: "security safe protect" },
  { label: "Fingerprint", glyph: "", words: "identity security" },
  { label: "People", glyph: "", words: "family friends group team" },
  { label: "Contact", glyph: "", words: "person user me account" },
  { label: "Chat", glyph: "", words: "message talk" },
  { label: "Mail", glyph: "", words: "email letters" },
  { label: "Phone", glyph: "", words: "call mobile" },
  { label: "Home", glyph: "", words: "house personal" },
  { label: "Globe", glyph: "", words: "world web internet" },
  { label: "Map pin", glyph: "", words: "place location travel" },
  { label: "Airplane", glyph: "", words: "travel trip flight holiday" },
  { label: "Car", glyph: "", words: "drive vehicle" },
  { label: "Train", glyph: "", words: "travel rail" },
  { label: "Shop", glyph: "", words: "shopping bag store buy" },
  { label: "Calculator", glyph: "", words: "money finance tax numbers" },
  { label: "Health", glyph: "", words: "medical doctor fitness" },
  { label: "Sun", glyph: "", words: "summer bright day" },
  { label: "Moon", glyph: "", words: "night sleep" },
  { label: "Settings", glyph: "", words: "gear config options" },
  { label: "Repair", glyph: "", words: "fix tools wrench" },
  { label: "Laptop", glyph: "", words: "computer pc" },
  { label: "Keyboard", glyph: "", words: "type computer" },
  { label: "Hard drive", glyph: "", words: "disk storage backup" },
  { label: "USB", glyph: "", words: "drive stick" },
  { label: "Network", glyph: "", words: "share lan" },
  { label: "Save", glyph: "", words: "disk keep" },
  { label: "Print", glyph: "", words: "printer paper" },
  { label: "Emoji", glyph: "", words: "smile fun happy" },
];

/** The icons whose name or words hold every word typed, in their own order. */
export function findIcons(typed: string) {
  const wanted = typed.toLowerCase().split(/\s+/).filter(Boolean);
  return FOLDER_ICONS.filter(({ label, words }) => {
    const text = `${label} ${words}`.toLowerCase();
    return wanted.every((word) => text.includes(word));
  });
}
