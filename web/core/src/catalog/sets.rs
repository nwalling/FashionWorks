//! Set grouping and variant linking, ported from `catalog.py`.
//!
//! **The game's own grouping data does not describe sets.** `Set_<n>` is
//! present on only part of a family and absent from the rest, and the path
//! fallback is far too coarse, so the two together split 48 families across
//! several keys while lumping unrelated families into one. Corbel is the clean
//! example: its four helmets carry `Set_01` and land on `cds_heavy_set01`
//! (shared with 21 other product lines), its arms, legs and core carry no set
//! tag and fall back to a path, and `Corbel Helmet Crush` has no manufacturer
//! code so it lands on a third key. Equipping the full set could never work.
//!
//! The display name is the reliable signal, because it is what CIG shows the
//! player and it names the product. Taking the words before the slot word gives
//! 38 complete helmet/torso/arms/legs sets against 33 for the tag-and-path
//! scheme, with no product split across keys and no key mixing products. It
//! also keeps "The Butcher" apart from "The Hill Horror", and "Odyssey" from
//! "Odyssey II Racing", which keying on the first word alone does not.

/// Words that end the product part of a display name.
///
/// The same thirteen the Python matches, in the same order.
const SLOT_WORDS: [&str; 13] = [
    "helmet", "helm", "core", "torso", "arms", "arm", "legs", "leg", "backpack", "pack",
    "undersuit", "suit", "flight",
];

/// Tags are one space-separated string, not a list of references.
///
/// `"Marine_Light Set_02 Color_02 SM_Marine"` is the shape. `Set_<n>` and
/// `Color_<n>` give exact variant linking, far better than guessing from class
/// names.
pub fn tag_value(tags: &[String], prefix: &str) -> Option<String> {
    let want = format!("{}_", prefix.to_ascii_lowercase());
    tags.iter().find_map(|tag| {
        let lowered = tag.to_ascii_lowercase();
        lowered
            .strip_prefix(&want)
            .filter(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_alphanumeric() || c == '_'))
            .map(str::to_string)
    })
}

/// The product part of a display name: everything before the slot word.
pub fn product_key(name: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for word in name.split_whitespace() {
        let bare = word.trim_matches(|c| c == '"' || c == '(' || c == ')');
        if SLOT_WORDS.iter().any(|w| w.eq_ignore_ascii_case(bare)) {
            break;
        }
        kept.push(word);
    }
    kept.join(" ").trim().to_ascii_lowercase()
}

/// Strip a trailing colour/variant suffix to get the canonical item key.
pub fn canonical_key(class_name: &str) -> String {
    const SUFFIXES: [&str; 31] = [
        "black", "white", "grey", "gray", "red", "blue", "green", "orange", "yellow", "tan",
        "sand", "brown", "olive", "navy", "slate", "charcoal", "steel", "rust", "bone", "ash",
        "khaki", "forest", "crimson", "azure", "desert", "arctic", "jungle", "urban", "snow",
        "camo", "default",
    ];
    let mut key = class_name.to_ascii_lowercase();
    loop {
        let Some((head, tail)) = key.rsplit_once(['_', '-']) else {
            return key;
        };
        let is_suffix = SUFFIXES.contains(&tail)
            || tail == "base"
            || (tail.len() == 2 && tail.chars().all(|c| c.is_ascii_digit()));
        if !is_suffix || head.is_empty() {
            return key;
        }
        key = head.to_string();
    }
}

/// An item's tags.
///
/// `AttachDef.Tags` in this build is a single space-separated string, e.g.
/// `"Marine_Light Set_02 Color_02 SM_Marine"`, not the list of record
/// references an older shape used.
pub fn tags_for(record: &serde_json::Value) -> Vec<String> {
    let raw = super::attach_first(record, &["AttachDef.Tags"])
        .or_else(|| super::first(super::record_body(record), &["tags", "Tags"]));
    match raw.and_then(serde_json::Value::as_str) {
        Some(text) => text.split_whitespace().map(str::to_string).collect(),
        None => Vec::new(),
    }
}

/// Derive a set id, from the product name where there is one.
///
/// Items whose localisation key did not resolve have no usable name, so those
/// fall back to the tag-and-path scheme the way the Python does.
pub fn set_key(
    name: &str,
    flags: &[String],
    tags: &[String],
    manufacturer_code: &str,
    weight_class: Option<&str>,
    geometry: &[String],
    class_name: &str,
) -> String {
    if !flags.iter().any(|f| f == "unnamed") {
        let product = product_key(name);
        if !product.is_empty() {
            return product;
        }
    }

    if let Some(set_tag) = tag_value(tags, "Set") {
        let bits: Vec<String> = [
            manufacturer_code.to_string(),
            weight_class.unwrap_or("").to_string(),
            format!("set{set_tag}"),
        ]
        .into_iter()
        .filter(|b| !b.is_empty())
        .collect();
        return bits.join("_").to_ascii_lowercase();
    }

    let mut prefix = String::new();
    if let Some(first) = geometry.first() {
        let parts: Vec<&str> = first.split('/').collect();
        if parts.len() >= 3 {
            prefix = parts[..parts.len() - 2].join("/");
        }
    }
    let bits: Vec<String> = [prefix, manufacturer_code.to_string(), weight_class.unwrap_or("").to_string()]
        .into_iter()
        .filter(|b| !b.is_empty())
        .collect();
    if bits.is_empty() {
        return canonical_key(class_name);
    }
    bits.join("|").to_ascii_lowercase()
}

/// What identifies a mesh, for grouping items that differ only by tint.
pub fn geometry_key(sources: &[String]) -> Vec<String> {
    let mut out: Vec<String> = sources.iter().map(|s| s.to_ascii_lowercase()).collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_product_is_what_comes_before_the_slot_word() {
        assert_eq!(product_key("Corbel Arms Crush"), "corbel");
        assert_eq!(product_key("Corbel Helmet Crush"), "corbel");
        // The whole point: every Corbel piece lands on one key, where the
        // game's own tags scattered them across three.
        assert_eq!(product_key("Corbel Core"), product_key("Corbel Legs Halcyon"));
    }

    #[test]
    fn products_that_share_a_first_word_stay_apart() {
        assert_ne!(product_key("The Butcher Helmet"), product_key("The Hill Horror Helmet"));
        assert_ne!(product_key("Odyssey Helmet Tan"), product_key("Odyssey II Racing Helmet Aqua"));
    }

    #[test]
    fn a_slot_word_in_quotes_or_brackets_still_ends_the_product() {
        assert_eq!(product_key("Venture \"Arms\" Sienna"), "venture");
        assert_eq!(product_key("FBL-8a (Arms) Modified"), "fbl-8a");
    }

    #[test]
    fn tags_are_one_space_separated_string() {
        let tags: Vec<String> = "Marine_Light Set_02 Color_02 SM_Marine"
            .split_whitespace()
            .map(str::to_string)
            .collect();
        assert_eq!(tag_value(&tags, "Set").as_deref(), Some("02"));
        assert_eq!(tag_value(&tags, "Color").as_deref(), Some("02"));
        assert_eq!(tag_value(&tags, "Missing"), None);
    }

    #[test]
    fn trailing_variant_suffixes_strip_until_stable() {
        // Not one pass: `_black` comes off, then the `_01` underneath it.
        // Checked against the Python, which loops to a fixed point the same way.
        assert_eq!(canonical_key("cds_heavy_arms_01_black"), "cds_heavy_arms");
        assert_eq!(canonical_key("cds_heavy_arms_01_01"), "cds_heavy_arms");
        assert_eq!(canonical_key("cds_heavy_arms_01"), "cds_heavy_arms");
        // Nothing to strip.
        assert_eq!(canonical_key("corbel_helmet"), "corbel_helmet");
    }

    #[test]
    fn a_numbered_product_keeps_its_number() {
        // "Odyssey II Racing" must not collapse to "odyssey", or the two
        // product lines merge.
        assert_eq!(product_key("Odyssey II Racing Helmet Aqua"), "odyssey ii racing");
    }
}
