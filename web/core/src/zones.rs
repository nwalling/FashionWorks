//! Body zones: which named zone each submesh of a character mesh is.
//! CLOTHING.md Phase 0.
//!
//! A character mesh is split into zone submeshes, the units
//! `SCItemClothingParams.Chunks` hides: a shirt at layer 1 lists `torso01_zone`
//! and the body's chest submesh is not drawn under it. The mesh does not name
//! them. After its submesh list it carries a sorted table of 32-bit words, one
//! per zone, and each submesh's `node_parent_index` indexes that table. The
//! same zone has the same word in every mesh -- the body, and every shirt and
//! jacket that shares its torso and arm zones -- but the words are not the
//! CRC32, CRC32C, FNV-1/1a, djb2, MurmurHash3 or xxHash32 of any spelling of
//! the names, so they are read off the geometry instead.
//!
//! **How the table was derived** (`examples/zone_words.rs`, then the body's own
//! vertices): the male body is 30 submeshes and the female 31, sharing 30
//! words. Off-centre submeshes split by side (the character faces +y, so left
//! is -x), arms in order of distance out -- shoulder, `arm01`..`arm05`, hand --
//! and legs top to bottom -- `leg01`..`leg04`, foot. The six central ones are
//! told apart by where they sit and by which items cover them: the narrow V at
//! the collar is `vneck` (shirts without it are the V-necks); the upper chest,
//! front only, is `torso01` (open-collar shirts leave it bare); the abdomen,
//! front only, `torso02`; the mid and lower back `torso03` and `torso04`
//! (open-front jackets cover just those two); the pelvis `underwear` (armour
//! legs cover only it). The female's extra submesh is `underwear_top`.
//! `hips_zone` is not on the body at all: it is the waistband of trousers,
//! which shirts and jackets hide.

/// The body's zone words and their names.
const BODY: &[(u32, &str)] = &[
    (3734923156, "l_arm01_zone"),
    (2158656605, "l_arm02_zone"),
    (2786327254, "l_arm03_zone"),
    (720472639, "l_arm04_zone"),
    (223569136, "l_arm05_zone"),
    (2816120557, "l_foot_zone"),
    (3335329176, "l_hand_zone"),
    (305801918, "l_leg01_zone"),
    (4216078907, "l_leg02_zone"),
    (3307813788, "l_leg03_zone"),
    (1310796465, "l_leg04_zone"),
    (1353240489, "l_shoulder_zone"),
    (1220857574, "r_arm01_zone"),
    (2495460195, "r_arm02_zone"),
    (601819236, "r_arm03_zone"),
    (1733366137, "r_arm04_zone"),
    (2977709874, "r_arm05_zone"),
    (3312375675, "r_foot_zone"),
    (998859158, "r_hand_zone"),
    (52402792, "r_leg01_zone"),
    (410468673, "r_leg02_zone"),
    (2526608570, "r_leg03_zone"),
    (3186933963, "r_leg04_zone"),
    (1020047223, "r_shoulder_zone"),
    (3955070026, "torso01_zone"),
    (320886823, "torso02_zone"),
    (3157836472, "torso03_zone"),
    (3044089349, "torso04_zone"),
    (3553630895, "underwear_top_zone"),
    (522799459, "underwear_zone"),
    (2432608691, "vneck_zone"),
];

/// Zones only garments carry, named where the evidence is unambiguous.
///
/// Most garment-only words belong to a single garment, and the records cannot
/// name them: every statistic tried measures garment type -- shirts and
/// jackets list the `omega_*` zones, trousers do not -- rather than the zone.
/// This one is shared by 35 shirt meshes, is an all-round band at the waist
/// (z 1.04-1.06 on `f_eld_shirt_04`), and 271 of the 273 records whose mesh
/// carries it list `hips_zone` -- the other two are one training shirt's
/// colourways. It is the shirt's hem, which a jacket covering the hips hides.
const GARMENT: &[(u32, &str)] = &[(232552810, "hips_zone")];

/// Zones armour carries, named the same way: a word carried by the meshes of
/// the records that list the zone, read off the 606 male character meshes the
/// pipeline has extracted.
///
/// * `theta_head_zone` is what a helmet draws only beside its own core -- the
///   Artimex cowl and breathing tube, the Geist ASD hood
///   (`catalog::visibility`). Eleven meshes carry it, and the ten a record
///   names belong to the eight families whose records list the zone: the
///   Artimex, Geist ASD, Arden-SL, Palatino, Outback, Inmate Work and Ixonia
///   helmets and the Piecemeal core. (`m_kap_light_combat_helmet_02_01`, the
///   eleventh, no record names.) On the Artimex helmet it is three submeshes:
///   the cowl at the back of the head, the tube down the chest and the piece
///   under the chin.
/// * `omega_core_zone`: every one of the sixteen meshes carrying it that a
///   record names lists the zone -- cores at layer 4, undersuits at 3. On a
///   core it is a part at the neck or the back (the Artimex core's neck ring
///   and cloak, the Clash core's back plate); on an undersuit a torso part a
///   core covers (the Odyssey II's at the waist, the BUL-H4's collar).
/// * `theta_core_zone`: on all four families whose records condition it -- the
///   Aril core, the BUL-H4, the VGL flight suits and the Inmate Work undersuit.
///   Three more meshes carry it as their main part without listing the zone
///   (the Ixonia helmet, two Carrion cores, the Vagabond jacket), where
///   nothing reads it.
/// * `theta_legs_zone`: on exactly the two meshes whose records list it, the
///   Aril core and legs. `theta_arms_zone`: on the one, the Aril arms.
/// * `theta_pouch01..06_zone`: the Morozov-SH-I Stronghold core's six magazine
///   pouches. Each pouch's submeshes lie 3-4 cm from one `magazine_attach_N`
///   bone of the core's own skeleton (`examples/zone_bones.rs`), and that is
///   the port the record conditions the pouch on -- pouch 01 on
///   `magazine_attach_2`, 02 on 3, 03 on 8, 04 on 6, 05 on 7, 06 on 4.
const ARMOUR: &[(u32, &str)] = &[
    (2583318635, "theta_head_zone"),
    (3423257195, "omega_core_zone"),
    (220912766, "theta_core_zone"),
    (2424359756, "theta_legs_zone"),
    (347428306, "theta_arms_zone"),
    (450076817, "theta_pouch01_zone"),
    (992117880, "theta_pouch02_zone"),
    (3234042855, "theta_pouch03_zone"),
    (1097721502, "theta_pouch04_zone"),
    (495489989, "theta_pouch05_zone"),
    (255744764, "theta_pouch06_zone"),
];

/// The zone a submesh word names, where it is known.
pub fn name(word: u32) -> Option<&'static str> {
    BODY.iter().chain(GARMENT).chain(ARMOUR).find(|(w, _)| *w == word).map(|(_, n)| *n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_body_zone_has_one_word() {
        let mut names: Vec<&str> = BODY.iter().map(|(_, n)| *n).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), BODY.len(), "one word per zone");
        assert_eq!(BODY.len(), 31);
        assert_eq!(name(3955070026), Some("torso01_zone"));
        assert_eq!(name(232552810), Some("hips_zone"), "the shirt hem");
        assert_eq!(name(2583318635), Some("theta_head_zone"), "the Artimex cowl");
        let mut words: Vec<u32> = BODY.iter().chain(GARMENT).chain(ARMOUR).map(|(w, _)| *w).collect();
        words.sort_unstable();
        words.dedup();
        assert_eq!(words.len(), BODY.len() + GARMENT.len() + ARMOUR.len(), "no word names two zones");
        assert_eq!(name(1), None);
    }
}
