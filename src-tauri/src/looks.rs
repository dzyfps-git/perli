//! What a picture looks like, in a few numbers: a fingerprint for finding pictures that look
//! alike, how sharp it is, and its main colour. All read from one small copy that Windows'
//! imaging makes, and kept until the file changes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use windows::core::HSTRING;
use windows::Win32::Foundation::GENERIC_READ;
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory, WICBitmapInterpolationModeFant, WICConvertBitmapSource,
    WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};

use crate::folder::{Entry, Sight, PICTURE_TYPES};
use crate::ops::sys::{self, Stat};
use crate::ops::Com;
use crate::preview::Known;

/// The small copy's edge. Enough to tell sharp from soft, and quick to make.
const EDGE: u32 = 64;
/// Fingerprints this many bits apart or fewer, of 64, look alike.
const ALIKE: u32 = 10;
/// The property a column asks for to sort by colour, as `preview::props_of` reads it.
pub const COLOUR: &str = "look:colour";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    /// A difference hash: how brightness steps across a 9 by 8 copy.
    pub hash: u64,
    /// The variance of the Laplacian: higher is sharper.
    pub sharp: f32,
    pub colour: [u8; 3],
    /// Hardly any colour: greys, black and white, or a washed-out picture.
    pub grey: bool,
}

static KNOWN: Known<Look> = Known::new(100_000);

fn is_picture(path: &Path) -> bool {
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or_default().to_ascii_lowercase();
    PICTURE_TYPES.contains(&extension.as_str())
}

/// How `path` looks, or nothing for a file that is no picture, can't be read, or is only in the
/// cloud, which reading would fetch.
pub fn look(path: &Path) -> Option<Look> {
    if !is_picture(path) || crate::thumbs::is_online_only(path) {
        return None;
    }
    let (key, stamp) = (path.to_string_lossy().to_lowercase(), sys::stamp(path).ok()?);
    if let Some(known) = KNOWN.get(&key, stamp) {
        return Some(known);
    }
    let found = of_pixels(&small(path)?);
    KNOWN.put(key, stamp, found);
    Some(found)
}

/// The picture squeezed to `EDGE` by `EDGE`, as red, green, blue and alpha.
fn small(path: &Path) -> Option<Vec<u8>> {
    let _com = Com::enter();
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let decoder = factory.CreateDecoderFromFilename(&HSTRING::from(path), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand).ok()?;
        let frame = decoder.GetFrame(0).ok()?;
        let scaler = factory.CreateBitmapScaler().ok()?;
        scaler.Initialize(&frame, EDGE, EDGE, WICBitmapInterpolationModeFant).ok()?;
        let pixels = WICConvertBitmapSource(&GUID_WICPixelFormat32bppRGBA, &scaler).ok()?;
        let mut out = vec![0; (EDGE * EDGE * 4) as usize];
        pixels.CopyPixels(std::ptr::null(), EDGE * 4, &mut out).ok()?;
        Some(out)
    }
}

/// The look of an `EDGE` by `EDGE` picture, from its pixels.
fn of_pixels(rgba: &[u8]) -> Look {
    let edge = EDGE as usize;
    let grey: Vec<f32> = rgba.as_chunks::<4>().0.iter().map(|px| 0.299 * f32::from(px[0]) + 0.587 * f32::from(px[1]) + 0.114 * f32::from(px[2])).collect();

    // The fingerprint: the picture as 9 by 8 averages, each bit telling whether brightness rises
    // to the right.
    let mut cells = [[0f32; 9]; 8];
    for (y, row) in cells.iter_mut().enumerate() {
        for (x, cell) in row.iter_mut().enumerate() {
            let (left, right) = (x * edge / 9, ((x + 1) * edge / 9).max(x * edge / 9 + 1));
            let (top, bottom) = (y * edge / 8, (y + 1) * edge / 8);
            let mut sum = 0.0;
            for yy in top..bottom {
                sum += grey[yy * edge + left..yy * edge + right].iter().sum::<f32>();
            }
            *cell = sum / ((right - left) * (bottom - top)) as f32;
        }
    }
    let mut hash = 0u64;
    for row in &cells {
        for x in 0..8 {
            hash = hash << 1 | u64::from(row[x] < row[x + 1]);
        }
    }

    // Sharpness: how much the Laplacian swings. A blurred shot swings less.
    let mut laplace = Vec::with_capacity((edge - 2) * (edge - 2));
    for y in 1..edge - 1 {
        for x in 1..edge - 1 {
            let at = y * edge + x;
            laplace.push(grey[at - 1] + grey[at + 1] + grey[at - edge] + grey[at + edge] - 4.0 * grey[at]);
        }
    }
    let mean = laplace.iter().sum::<f32>() / laplace.len() as f32;
    let sharp = laplace.iter().map(|value| (value - mean).powi(2)).sum::<f32>() / laplace.len() as f32;

    let (colour, grey) = main_colour(rgba);
    Look { hash, sharp, colour, grey }
}

/// The colour most of the picture has: of twelve hues, the one its colourful pixels lean to most,
/// as their average. A picture with hardly any colour gives its average grey.
fn main_colour(rgba: &[u8]) -> ([u8; 3], bool) {
    let mut bins = [(0f32, [0f32; 3], 0f32); 12];
    let mut all = [0f32; 3];
    let pixels = rgba.len() / 4;
    for px in rgba.as_chunks::<4>().0 {
        let [red, green, blue] = [px[0], px[1], px[2]].map(f32::from);
        all[0] += red;
        all[1] += green;
        all[2] += blue;
        let (high, low) = (red.max(green).max(blue), red.min(green).min(blue));
        let saturation = if high > 0.0 { (high - low) / high } else { 0.0 };
        // Too dark to tell a hue. Bright highlights have too little saturation to count already,
        // while a solid red or blue, as bright as can be, keeps its hue.
        if saturation < 0.2 || high < 30.0 {
            continue;
        }
        let bin = &mut bins[(hue_of([red, green, blue]) / 30.0) as usize % 12];
        bin.0 += saturation;
        bin.1[0] += red;
        bin.1[1] += green;
        bin.1[2] += blue;
        bin.2 += 1.0;
    }
    let best = bins.iter().max_by(|a, b| a.0.total_cmp(&b.0)).copied().unwrap_or_default();
    // Colour on under a tenth of the picture reads as grey.
    if best.2 < pixels as f32 * 0.1 {
        return (all.map(|sum| (sum / pixels.max(1) as f32).round() as u8), true);
    }
    (best.1.map(|sum| (sum / best.2).round() as u8), false)
}

/// The hue in degrees, 0 to 360.
fn hue_of([red, green, blue]: [f32; 3]) -> f32 {
    let (high, low) = (red.max(green).max(blue), red.min(green).min(blue));
    let span = high - low;
    if span <= 0.0 {
        return 0.0;
    }
    let hue = if high == red {
        ((green - blue) / span).rem_euclid(6.0)
    } else if high == green {
        (blue - red) / span + 2.0
    } else {
        (red - green) / span + 4.0
    };
    hue * 60.0
}

/// A colour as text that sorts in rainbow order, greys first from dark to light, with the
/// colour itself at the end for the column to show: `1 210 140 #4a8ad8`.
pub fn colour_text(look: &Look) -> String {
    let [red, green, blue] = look.colour;
    let light = (u32::from(red.max(green).max(blue)) + u32::from(red.min(green).min(blue))) * 999 / 510;
    let hex = format!("#{red:02x}{green:02x}{blue:02x}");
    if look.grey {
        format!("0 {light:03} {hex}")
    } else {
        format!("1 {:03} {light:03} {hex}", hue_of(look.colour.map(f32::from)).round() as u32 % 360)
    }
}

/// How each of `paths` looks, read on a few threads, since each picture waits on the disk and
/// the decoder.
pub fn looks_of(paths: &[PathBuf]) -> Vec<Option<Look>> {
    read_all(paths, &|| false)
}

fn read_all(paths: &[PathBuf], stopped: &(dyn Fn() -> bool + Sync)) -> Vec<Option<Look>> {
    let next = AtomicUsize::new(0);
    let threads = thread::available_parallelism().map_or(4, |count| count.get()).min(8).min(paths.len().max(1));
    let parts: Vec<Vec<(usize, Option<Look>)>> = thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| {
                    let mut mine = Vec::new();
                    loop {
                        let at = next.fetch_add(1, Ordering::Relaxed);
                        if at >= paths.len() || stopped() {
                            break;
                        }
                        mine.push((at, look(&paths[at])));
                    }
                    mine
                })
            })
            .collect();
        workers.into_iter().map(|worker| worker.join().unwrap_or_default()).collect()
    });
    let mut found = vec![None; paths.len()];
    for (at, seen) in parts.into_iter().flatten() {
        found[at] = seen;
    }
    found
}

/// A picture with how it looks and what it takes, for Twins.
pub struct Seen {
    pub path: PathBuf,
    pub bytes: u64,
    /// FILETIME ticks.
    pub modified: u64,
    pub look: Look,
}

/// The pictures under `folders` that look alike, in sets, the set with most pictures first.
/// Hidden ones and ones only in the cloud stay out.
// ponytail: compares every pair, fine for some thousands of pictures; a BK-tree over the
// fingerprints if folders of hundreds of thousands are asked for.
pub fn alike(folders: &[PathBuf], stopped: &(dyn Fn() -> bool + Sync)) -> Vec<Vec<Seen>> {
    let sight = Sight { hidden: false, system: false };
    let mut pictures: Vec<(PathBuf, u64, u64)> = Vec::new();
    let mut waiting = folders.to_vec();
    while let Some(at) = waiting.pop() {
        if stopped() {
            return Vec::new();
        }
        let _ = sys::each_entry(&sys::extended(&at.join("*")), |data| {
            let Some(entry) = Entry::from_find_data(data) else { return };
            if !sight.shows(&entry) || entry.is_cloud() {
                return;
            }
            let path = at.join(entry.file_name());
            let stat = Stat::from_find_data(data);
            if stat.is_folder() {
                waiting.push(path);
            } else if stat.is_file() && is_picture(&path) {
                pictures.push((path, entry.size(), entry.modified()));
            }
        });
    }

    let paths: Vec<PathBuf> = pictures.iter().map(|(path, _, _)| path.clone()).collect();
    let looks = read_all(&paths, stopped);
    if stopped() {
        return Vec::new();
    }

    let seen: Vec<Seen> = pictures
        .into_iter()
        .zip(looks)
        .filter_map(|((path, bytes, modified), look)| Some(Seen { path, bytes, modified, look: look? }))
        .collect();
    let hashes: Vec<u64> = seen.iter().map(|one| one.look.hash).collect();
    let group_of = group_numbers(&hashes);
    let count = group_of.iter().flatten().max().map_or(0, |most| most + 1);
    let mut sets: Vec<Vec<Seen>> = (0..count).map(|_| Vec::new()).collect();
    for (one, group) in seen.into_iter().zip(group_of) {
        if let Some(group) = group {
            sets[group].push(one);
        }
    }
    sets.retain(|set| set.len() > 1);
    sets.sort_by_key(|set| std::cmp::Reverse(set.len()));
    sets
}

/// Each fingerprint's group, numbered from 0, or nothing for one in no group. Every member of a
/// group is alike to every other, so whichever one stays, each that goes looks like it: a, b
/// alike and b, c alike put c in with them only when a and c are alike too. A group grows from
/// the first fingerprint not in one yet, taking the nearest first.
fn group_numbers(hashes: &[u64]) -> Vec<Option<usize>> {
    let apart = |a: usize, b: usize| (hashes[a] ^ hashes[b]).count_ones();
    let mut group = vec![None; hashes.len()];
    let mut count = 0;
    for seed in 0..hashes.len() {
        if group[seed].is_some() {
            continue;
        }
        let mut near: Vec<usize> = (seed + 1..hashes.len()).filter(|&other| group[other].is_none() && apart(seed, other) <= ALIKE).collect();
        near.sort_by_key(|&other| apart(seed, other));
        let mut members = vec![seed];
        for other in near {
            if members.iter().all(|&member| apart(member, other) <= ALIKE) {
                members.push(other);
            }
        }
        if members.len() > 1 {
            for member in members {
                group[member] = Some(count);
            }
            count += 1;
        }
    }
    group
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture of `EDGE` by `EDGE` from a pixel rule.
    fn painted(paint: impl Fn(usize, usize) -> [u8; 3]) -> Vec<u8> {
        let edge = EDGE as usize;
        (0..edge * edge).flat_map(|at| { let [r, g, b] = paint(at % edge, at / edge); [r, g, b, 255] }).collect()
    }

    #[test]
    fn a_slightly_changed_picture_keeps_its_fingerprint_and_a_different_one_does_not() {
        let ramp = painted(|x, y| { let v = ((x * 3 + y * 2) % 256) as u8; [v, v, v] });
        let brighter = painted(|x, y| { let v = ((x * 3 + y * 2) % 256) as u8; [v.saturating_add(6); 3] });
        let other = painted(|x, y| { let v = (255 - (x * 3 + y * 2) % 256) as u8; [v, v, v] });
        let (a, b, c) = (of_pixels(&ramp).hash, of_pixels(&brighter).hash, of_pixels(&other).hash);
        assert!((a ^ b).count_ones() <= ALIKE);
        assert!((a ^ c).count_ones() > ALIKE);
    }

    #[test]
    fn a_sharp_picture_scores_higher_than_a_soft_one() {
        let sharp = painted(|x, y| if (x / 2 + y / 2) % 2 == 0 { [255; 3] } else { [0; 3] });
        let soft = painted(|x, _| { let v = (x * 4) as u8; [v, v, v] });
        assert!(of_pixels(&sharp).sharp > of_pixels(&soft).sharp * 10.0);
    }

    #[test]
    fn the_main_colour_is_the_one_most_of_the_picture_has() {
        let mostly_blue = painted(|x, _| if x < 48 { [40, 90, 220] } else { [220, 40, 40] });
        let look = of_pixels(&mostly_blue);
        assert!(!look.grey);
        assert_eq!(look.colour, [40, 90, 220]);
        let grey = of_pixels(&painted(|_, _| [120, 120, 125]));
        assert!(grey.grey);
        assert!(colour_text(&grey).starts_with("0 "));
        assert!(colour_text(&look).starts_with("1 22"));
        assert!(colour_text(&look).ends_with("#285adc"));
        // As bright as a colour gets: still a colour, not grey.
        for solid in [[255, 0, 0], [0, 0, 255], [255, 255, 0]] {
            let look = of_pixels(&painted(|_, _| solid));
            assert!(!look.grey, "{solid:?}");
            assert_eq!(look.colour, solid);
        }
        assert!(of_pixels(&painted(|_, _| [255, 250, 250])).grey);
    }

    #[test]
    fn each_in_a_group_is_alike_to_every_other() {
        // The third is alike to the second only, not to the first, so it stays out.
        let hashes = [0u64, 0b111, 0b1_1111_1111_1111, u64::MAX, u64::MAX ^ 1];
        assert_eq!(group_numbers(&hashes), vec![Some(0), Some(0), None, Some(1), Some(1)]);
        assert_eq!(group_numbers(&[0, u64::MAX]), vec![None, None]);
        // Each alike to every other: one group.
        assert_eq!(group_numbers(&[0, 0b1, 0b11, 0b111]), vec![Some(0); 4]);
    }
}
