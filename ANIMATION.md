# ANIMATION.md -- what the archive offers for poses, idles and emotes

Research, 2026-11-06, asked for by Noel: "a wider variety of animations and
emotes ... everything the data.p4k could offer us". Read off 4.10.2
(`/Volumes/Plex/SC Data`, build 4.10.196.368). Nothing here is built yet.
`CLAUDE.md` "Poses" and `LOADOUT.md` record what the kitbasher already plays:
the customizer idle, the stand/crouch/raised stances and the weapon sets.

## 1. The inventory

`Data/Animations` holds **60,596 entries**. For the human player rig
(`Characters/Human/male_v7`, mirrored under `female_v2`) the sets that matter:

| set | where | size | what |
| --- | --- | --- | --- |
| emotes | `male_v7/emotes.dba` | 114 clips, 11.9 MB (female 112, 10.75 MB) | the chat emotes' body clips |
| ASL | loose `.caf` beside it | 20 signs | the `asl_*` emotes |
| unwired emotes | loose `emotes/emote_nw_*.caf` | -- | localized, in neither the emote record nor the fragment database (below) |
| shop poses | `shop_loadout_display_poses.dba` | 13 clips, 64 KB | the game's own armour display poses |
| character select | `character_select_screen.dba` | `charselect_{light,med,heavy}_{marine,outlaw}` | near-still loops |
| AI idles | `ai/civ/standing_idles/ai_nw_neutral_stand_a_idle_*` | 24 loops, 5-16 s | standing idles, seams at most 0.57 degrees |
| idle fidgets | -- | 12 | short one-shots over an idle |
| idle moods | `playerIdleAnims.adb` tags | calm, excited, drunk 9, junkie 7, punk 13, electrified, severe pain | |
| leaning | wall leans | 146 clips, clean loops | need a wall |
| sitting | AI sit clips, `use.dba` (41.6 MB, 680 clips) | 2,070 AI sit clips | seat height in the name: `sit000` floor, `sit050/075/188`, barstool, chair, `table080/112` |
| hand grips | finger blendspaces | block, cupped, cylindrical, flat, bar, square, tableware, grenade, medpen | for held gadgets |

The female set matches the male's clip for clip, except three walk-slow
salutes.

## 2. Emotes

**The game's emote list is one DataCore record**: `ChatEmoteRecord`
`.ChatEmotePacks` (one pack, `Standard`). It holds **187 emotes, 148 enabled
in 4.10.2**. Each one has:

- a chat command (`@chat_emote_dance` -> "dance") and its chat line ("You
  nod.");
- a Mannequin fragment, always `emote`, plus a tag (`acknowledge+random`);
- a type: 181 `Social` and 6 `CombatSignal` (forward, left, right, stop, yes,
  no).

`Mannequin/ADB/Players/playerEmoteAnims.adb` (631 fragments) maps fragment
and tag to clips:

- a body clip;
- a `scope_face` partner for the face;
- per-weapon `_add` clips for the combat signals.

The fragments blend in and out over 0.2 s, and a held emote is an
enter/loop/exit sequence. The keybind names are the 40 `player_emotes`
actions in `Libs/Config/defaultProfile.xml` (`@ui_CIEmote*`).

**Enabled** (numbered variants are separate clips): agree, angry, the ASL
signs (angry, blah, bored, bullshit, can't hear, exhausted, goodbye, hello,
love you, meet you, no, sad, sit down, thanks, upset, yes), at ease,
attention, blah, bored, burp, cheer (9), chicken, clap (8), come, cry,
disagree, failure, flex, flirt, gasp (6), gloat, greet, laugh, point, rude,
salute, sit, smell, threaten, wait, wave, whistle, and the combat signals.
Two enabled entries, `sit2` and `launch`, name no body clip.

**Disabled in 4.10.2, though every clip is present and parses:** dance (7),
bow (7), sleep, acknowledge, disbelief, friendly and taunt, plus a few
numbered variants of agree, failure and threaten. The record also carries a
disabled self-harm emote, which the kitbasher should never offer.

**Not wired up at all:** loose `emote_nw_*` clips, localized but referenced by
neither the record nor the ADB: facepalm, payme, quickdraw, shadowbox, phew,
shieldeyes, nocomms, cuckoo, wagfinger, a full surrender set
(handsup/dontshoot/behindhead/onyourknees, each enter/idle/exit), and
lie_sleep / sit_hugknees. Probably the next build's emotes.

## 3. Will they play on our figure?

**Yes, for bodies.**

- **Parsing:** every body clip tried parses with `tools/anim-dump` and
  `starbreaker-3d`: 12 `.dba` files and many loose `.caf`s.
- **Binding:** ten were bound against the 255-bone armature -- dance, cheer,
  sleep, sit, salute, clap, a hand signal, a fidget, a character-select idle
  and a shop pose. Each resolves 105-218 bones by CRC32, as the poses do, with
  **none unresolved**.
- **Playing:** the wasm `sampleClip` already plays `.caf` and `.dba`.

**Most emotes start and end on the standing idle.** In `loop_survey`, 95 of
the 114 emote clips close to within 0.08 degrees, at 3-24 s and 30 fps. That
makes them one-shots that leave from and return to a stand: a 0.2 s
crossfade from the customizer loop and back, as the game's fragments do.
They can loop as well. The transition clips are not loops (98-180 degrees
apart end to end) and are only for chaining.

**Floor emotes need the clip's hip height.** Lying is 0.178 m and sitting
0.109 m. The kitbasher applies rotations only and seats the feet
(`CLAUDE.md`, "The floor shadow, and poses that floated"). That is right for
standing and crouching and wrong for lying down: the hips would stay at
standing height. The player needs a floor rule for these, taken from the
clip.

**A StarBreaker quirk:** some `.dba`s name their first clip `anim_0` (in the
male `emotes.dba` it is `...atease_to_standidle...`), and some names carry
garbage prefix bytes. Match clips by the name the ADB gives, and fall back to
CRC where a name is mangled.

**Faces are not solved.**

- **What matches:** a face clip has 183 channels, exactly the head's
  `FACIAL_*` bone count.
- **What doesn't:** no channel id matches the CRC32 or CRC32C of a bone,
  DNA control or blendshape name in any casing, and the rotations are
  constant.
- **The rig:** the head runs on RigLogic (`Deformer="Protos"
  DynamicDNA="1"`, a 76 MB `.dna`).
- **Consequence:** expressions, talking and blinking are out of reach until
  the channel ids and the DNA are understood. Emotes play without their face
  partner meanwhile.

## 4. What to add first

| | what | effort | note |
| --- | --- | --- | --- |
| 1 | **An emote menu** | small-medium | the enabled `Social` emotes and ASL, by their game names, read from the record while the catalogue is built; a one-shot over the idle with a 0.2 s blend; repeat or loop optional |
| 2 | **Display poses** | small | the 13 shop poses and the character-select stances as pose buttons, through the existing pose path |
| 3 | **Idle variety** | small | the 24 AI idles and 12 fidgets, and the drunk/punk/calm moods, as alternatives to the customizer loop |
| 4 | **Held emotes** | medium | salute, at ease, attention, surrender, hug-knees, sleep: enter, hold, exit, and the hip-height rule for floor ones |
| 5 | **Sit and lean** | medium-large | needs a seat or wall prop at the clip's height |
| 6 | **Hand grips** | small-medium | finger poses for held gadgets and pens |
| 7 | **Faces** | unknown | blocked on the channel ids and RigLogic |

Whether to offer the emotes the game has switched off (the dances, bows and
sleep) is Noel's call: they are in the archive and play, but the game does
not offer them in 4.10.2. The self-harm emote is out either way.

## 5. Not determined

- The face channel-id scheme.
- Whether the disabled emotes are reachable some other way in 4.10.2.
- Root motion in emotes that travel.
- Loop seams for the female set (not run).

The survey files are in the session scratchpad (`anim-research/`): the
60,596-entry listing, the emote record and its table resolved to clips, the
fragment dump and the loop survey. They are game data and stay out of the
repository.
