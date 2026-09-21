//! Field access, ported from `extract/sc_extract/fields.py`.
//!
//! Two shapes in the DataCore make naive access wrong, and both were found the
//! hard way:
//!
//! * **`Components` is a list, not a map.** Each member carries its own type in
//!   `_Type_`. Looking a component up by a dotted path finds nothing, or worse
//!   finds the wrong one when the order differs between records.
//! * **The body is wrapped.** The record proper sits under `_RecordValue_`,
//!   with `_RecordName_` and `_RecordId_` as siblings.

use serde_json::Value;

/// The record proper, unwrapping `_RecordValue_` when it is present.
pub fn record_body(record: &Value) -> &Value {
    record.get("_RecordValue_").unwrap_or(record)
}

/// A component by its `_Type_`, searching the `Components` list.
pub fn component<'a>(record: &'a Value, type_name: &str) -> Option<&'a Value> {
    let components = record_body(record).get("Components")?.as_array()?;
    components
        .iter()
        .find(|entry| entry.get("_Type_").and_then(Value::as_str) == Some(type_name))
}

/// The first of several dotted paths that resolves to something non-null.
///
/// Field names are hypotheses until real data agrees with them, so every
/// lookup takes a list of candidates rather than a single path.
pub fn first<'a>(value: &'a Value, paths: &[&str]) -> Option<&'a Value> {
    for path in paths {
        let mut cursor = value;
        let mut ok = true;
        for part in path.split('.') {
            match cursor.get(part) {
                Some(next) => cursor = next,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && !cursor.is_null() {
            return Some(cursor);
        }
    }
    None
}

/// `first`, as a borrowed string.
pub fn first_str<'a>(value: &'a Value, paths: &[&str]) -> Option<&'a str> {
    first(value, paths)?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn components_are_found_by_type_not_position() {
        let record = json!({
            "_RecordValue_": { "Components": [
                { "_Type_": "SOtherThing", "value": 1 },
                { "_Type_": "SGeometryResourceParams", "Geometry": { "path": "a.skin" } }
            ]}
        });
        let geo = component(&record, "SGeometryResourceParams").unwrap();
        assert_eq!(geo["Geometry"]["path"], "a.skin");
        assert!(component(&record, "SMissing").is_none());
    }

    #[test]
    fn a_body_may_or_may_not_be_wrapped() {
        let wrapped = json!({ "_RecordValue_": { "x": 1 } });
        assert_eq!(record_body(&wrapped)["x"], 1);
        let bare = json!({ "x": 1 });
        assert_eq!(record_body(&bare)["x"], 1);
    }

    #[test]
    fn first_skips_paths_that_are_absent_or_null() {
        let value = json!({ "a": null, "b": { "c": "found" } });
        assert_eq!(first_str(&value, &["a", "b.c"]), Some("found"));
        assert_eq!(first_str(&value, &["nope"]), None);
    }
}
