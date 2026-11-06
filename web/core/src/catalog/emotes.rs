//! The emotes a player can play, and the clips behind each. ANIMATION.md.
//!
//! The game's list is one record, `ChatEmoteRecord.ChatEmotePacks`: 187
//! emotes, each a chat command (`@chat_emote_wave1`), the line it prints
//! (`You wave.`), whether 4.10.2 offers it, and a Mannequin fragment -- always
//! `emote` -- with a tag (`wave+1`, or `wave+random` for "any of them").
//! `Animations/Mannequin/ADB/Players/playerEmoteAnims.adb` gives each tag its
//! clips: a fragment is a sequence (a salute is attention-to-salute, then the
//! salute held), and a `+random` tag is several fragments to pick between.
//! The archive ships it as binary CryXML (`CryXmlB`); StarBreaker's extract
//! writes it out as text, which is how it reads in a dump.
//!
//! What the kitbasher offers is grouped by **kind** -- the command without its
//! number, `wave` for `wave`, `wave1` and `wave2` -- and a kind's variants are
//! every distinct sequence its commands name. Only the body: a fragment scoped
//! `scope_face` is the face's partner clip, which nothing here can play yet,
//! and one scoped to a weapon is a combat hand signal layered over that
//! weapon's stance. Social emotes only, for the same reason.
//!
//! The game switches some emotes off in 4.10.2 with every clip still in the
//! archive. Dances and bows are offered anyway, by Noel's decision; the rest
//! of what is switched off is not, and a self-harm emote among them never is.

use serde_json::{json, Value};

use super::Localization;

/// Switched off in the game and offered here all the same.
const OFFERED_THOUGH_OFF: &[&str] = &["dance", "bow"];

/// One fragment of the emote list: its tag and the clips it plays in order.
#[derive(Debug, PartialEq)]
pub struct Fragment {
    pub tags: String,
    pub clips: Vec<String>,
}

/// The ADB as XML text: binary CryXML written out, or text as it came.
pub fn adb_text(bytes: &[u8]) -> String {
    if starbreaker_cryxml::is_cryxmlb(bytes) {
        starbreaker_cryxml::from_bytes(bytes).map(|xml| xml.to_string()).unwrap_or_default()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// The unscoped fragments of an animation database's `emote` list, from its
/// XML text. Only `<Fragment>` and `<Animation>` matter, so it is scanned
/// rather than parsed.
pub fn fragments(adb: &str) -> Vec<Fragment> {
    let mut out = Vec::new();
    let mut rest = adb;
    while let Some(start) = rest.find("<Fragment ") {
        rest = &rest[start..];
        let end = rest.find("</Fragment>").unwrap_or(rest.len());
        let body = &rest[..end];
        let open = &body[..body.find('>').unwrap_or(body.len())];
        if attribute(open, "Tags").unwrap_or("").is_empty() {
            let tags = attribute(open, "FragTags").unwrap_or("").to_string();
            let mut clips = Vec::new();
            let mut inner = body;
            while let Some(at) = inner.find("<Animation ") {
                inner = &inner[at..];
                let tag_end = inner.find('>').unwrap_or(inner.len());
                if let Some(name) = attribute(&inner[..tag_end], "name") {
                    clips.push(name.to_string());
                }
                inner = &inner[tag_end..];
            }
            out.push(Fragment { tags, clips });
        }
        rest = &rest[end..];
    }
    out
}

/// `name="value"` in one start tag.
fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!(" {name}=\"");
    let from = tag.find(&needle)? + needle.len();
    let len = tag[from..].find('"')?;
    Some(&tag[from..from + len])
}

/// A clip the body can play: an emote clip, not its face partner. The list
/// also names `aegs_gladius_emote_thumbsup`, a ship seat's, which the body's
/// databases do not hold.
fn body_clip(name: &str) -> bool {
    name.starts_with("emote_") && !name.ends_with("_face")
}

/// The command a `@chat_emote_<command>` key names, and its kind: the command
/// less its trailing number.
fn command_of(key: &str) -> Option<(String, String)> {
    let command = key.strip_prefix('@')?.strip_prefix("chat_emote_")?.to_ascii_lowercase();
    let kind = command.trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
    (!kind.is_empty()).then_some((command, kind))
}

/// The emote menu: one entry per kind, `{kind, text, in_game, variants}`,
/// `variants` being each distinct clip sequence, numbered commands first.
pub fn build(record: &Value, loc: &Localization, adb: &[u8]) -> Vec<Value> {
    let fragments = fragments(&adb_text(adb));
    let body = record.get("_RecordValue_").unwrap_or(record);
    // kind -> (text, in game, [(command number, sequences)])
    let mut kinds: Vec<(String, String, bool, Vec<(u32, Vec<Vec<String>>)>)> = Vec::new();
    for pack in body["packs"].as_array().into_iter().flatten() {
        for emote in pack["emotes"].as_array().into_iter().flatten() {
            let anim = &emote["animData"];
            if anim["type"].as_str() != Some("Social") || anim["fragmentID"].as_str() != Some("emote") {
                continue;
            }
            let Some((command, kind)) = emote["emoteType"].as_str().and_then(command_of) else { continue };
            let enabled = emote["enabled"].as_bool().unwrap_or(false);
            if !enabled && !OFFERED_THOUGH_OFF.contains(&kind.as_str()) {
                continue;
            }
            let tag = anim["tagID"].as_str().unwrap_or("");
            let sequences: Vec<Vec<String>> = fragments
                .iter()
                .filter(|f| f.tags == tag)
                .map(|f| f.clips.iter().filter(|c| body_clip(c)).cloned().collect::<Vec<_>>())
                .filter(|clips| !clips.is_empty())
                .collect();
            if sequences.is_empty() {
                continue;
            }
            // `wave` is the random one; it sorts after `wave1`, `wave2`.
            let number = command[kind.len()..].parse::<u32>().unwrap_or(u32::MAX);
            let text = anim["textToDisplay"].as_str().and_then(|k| loc.get(k)).unwrap_or("").to_string();
            match kinds.iter_mut().find(|(k, ..)| *k == kind) {
                Some(entry) => {
                    entry.2 |= enabled;
                    if entry.1.is_empty() {
                        entry.1 = text;
                    }
                    entry.3.push((number, sequences));
                }
                None => kinds.push((kind, text, enabled, vec![(number, sequences)])),
            }
        }
    }
    kinds.sort_by(|a, b| a.0.cmp(&b.0));
    kinds
        .into_iter()
        .map(|(kind, text, in_game, mut commands)| {
            commands.sort_by_key(|(number, _)| *number);
            let mut variants: Vec<Vec<String>> = Vec::new();
            for sequence in commands.into_iter().flat_map(|(_, s)| s) {
                if !variants.contains(&sequence) {
                    variants.push(sequence);
                }
            }
            json!({ "kind": kind, "text": text, "in_game": in_game, "variants": variants })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADB: &str = r#"<AnimDB><FragmentList><emote>
      <Fragment GUID="a" Tags="" FragTags="salute+1">
        <AnimLayer>
          <Blend ExitTime="0" StartTime="0" Duration="0.2" />
          <Animation name="emote_acknowledge_m_stand_us_attention_to_salute_killian_01" />
          <Blend ExitTime="-1" StartTime="0" Duration="0.2" />
          <Animation name="emote_acknowledge_m_stand_us_idle_salute_killian_01" />
        </AnimLayer>
      </Fragment>
      <Fragment GUID="b" Tags="scope_face" FragTags="salute+1">
        <AnimLayer><Animation name="emote_acknowledge_m_stand_us_idle_salute_killian_01_face" /></AnimLayer>
      </Fragment>
      <Fragment GUID="c" Tags="" FragTags="dance+random">
        <AnimLayer><Animation name="emote_dance_m_stand_sway_generic_02" /></AnimLayer>
      </Fragment>
      <Fragment GUID="d" Tags="" FragTags="dance+random">
        <AnimLayer><Animation name="emote_dance_m_stand_funkydance_generic_01" /></AnimLayer>
      </Fragment>
      <Fragment GUID="e" Tags="" FragTags="dance+1">
        <AnimLayer><Animation name="emote_dance_m_stand_funkydance_generic_01" /></AnimLayer>
      </Fragment>
      <Fragment GUID="f" Tags="" FragTags="taunt+1">
        <AnimLayer><Animation name="emote_taunt_m_stand_generic_01" /></AnimLayer>
      </Fragment>
      <Fragment GUID="g" Tags="" FragTags="agree+random">
        <AnimLayer><Animation name="aegs_gladius_emote_thumbsup" /></AnimLayer>
      </Fragment>
    </emote></FragmentList></AnimDB>"#;

    fn emote(command: &str, tag: &str, enabled: bool) -> Value {
        json!({ "emoteType": format!("@chat_emote_{command}"), "enabled": enabled,
                "animData": { "fragmentID": "emote", "tagID": tag, "type": "Social",
                              "textToDisplay": format!("@chat_emote_{command}_text") } })
    }

    #[test]
    fn a_fragment_is_a_sequence_and_the_face_is_left_out() {
        let found = fragments(ADB);
        assert_eq!(found.len(), 6, "the scope_face fragment is not the body's");
        assert_eq!(found[0].tags, "salute+1");
        assert_eq!(found[0].clips.len(), 2, "attention to salute, then the salute held");
    }

    #[test]
    fn kinds_gather_their_commands_and_switched_off_dances_stay() {
        let record = json!({ "_RecordValue_": { "packs": [{ "emotes": [
            emote("salute1", "salute+1", true),
            emote("dance", "dance+random", false),
            emote("dance1", "dance+1", false),
            emote("taunt1", "taunt+1", false),
            emote("agree", "agree+random", true),
        ] }] } });
        let loc = Localization::parse("chat_emote_dance_text=You feel the music.\n");
        let menu = build(&record, &loc, ADB.as_bytes());
        let kinds: Vec<&str> = menu.iter().map(|e| e["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["dance", "salute"], "taunt is switched off; agree's only clip is a ship seat's");
        let dance = &menu[0];
        assert_eq!(dance["in_game"], false);
        assert_eq!(dance["text"], "You feel the music.");
        let variants = dance["variants"].as_array().unwrap();
        assert_eq!(variants.len(), 2, "dance1's clip is also one of the random ones: once");
        assert_eq!(variants[0][0], "emote_dance_m_stand_funkydance_generic_01", "numbered first");
        assert_eq!(menu[1]["variants"][0].as_array().unwrap().len(), 2);
    }
}
