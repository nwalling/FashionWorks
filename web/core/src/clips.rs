//! Sampling a whole animation clip, for the idle loop. RENDERING.md Phase 5.
//!
//! The still poses read one frame -- the last -- through StarBreaker's
//! `clip_final_pose`. A clip holds every frame: per bone, rotation keyframes
//! at their own times, not necessarily one per frame and not necessarily
//! starting at zero. This samples them at the clip's own rate onto one shared
//! frame grid, in the same archive `[w, x, y, z]` frame the still pose uses,
//! so a frame of a loop and a still pose apply the same way.
//!
//! It also scores a clip as a loop, which is how the idles were chosen: most
//! of `stand.dba`'s 189 clips are transitions, turns and one-offs that end
//! somewhere other than where they began.

use starbreaker_3d::animation::{cry_xyzw_to_blender_wxyz, AnimationClip, BoneChannel, Keyframe};

use crate::poses::Quat;

/// The first and last key time across a clip's rotation channels, in frames.
pub fn frame_range(clip: &AnimationClip) -> Option<(f32, f32)> {
    let times = clip.channels.iter().flat_map(|c| c.rotations.iter().map(|k| k.time));
    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
    for t in times {
        lo = lo.min(t);
        hi = hi.max(t);
    }
    (lo.is_finite() && hi.is_finite()).then_some((lo, hi))
}

/// A channel's rotation at `time`, in the archive's `[w, x, y, z]`.
///
/// Normalised lerp between the neighbouring keys, along the shorter arc.
/// Keys are dense -- one a frame on the clips measured -- so nlerp and slerp
/// differ by less than the keys' own quantisation. Before the first key and
/// after the last, the end key holds.
pub fn rotation_at(keys: &[Keyframe<[f32; 4]>], time: f32) -> Option<Quat> {
    let first = keys.first()?;
    if keys.len() == 1 || time <= first.time {
        return Some(cry_xyzw_to_blender_wxyz(first.value));
    }
    let last = keys.last()?;
    if time >= last.time {
        return Some(cry_xyzw_to_blender_wxyz(last.value));
    }
    // Keys are in time order; the first key after `time` bounds the span.
    let next = keys.partition_point(|k| k.time <= time);
    let (a, b) = (&keys[next - 1], &keys[next]);
    let span = (b.time - a.time).max(f32::EPSILON);
    let f = ((time - a.time) / span).clamp(0.0, 1.0);
    let (qa, mut qb) = (a.value, b.value);
    if qa.iter().zip(qb.iter()).map(|(x, y)| x * y).sum::<f32>() < 0.0 {
        qb = qb.map(|v| -v);
    }
    let mut q = [0.0f32; 4];
    for i in 0..4 {
        q[i] = qa[i] + (qb[i] - qa[i]) * f;
    }
    let n = q.iter().map(|v| v * v).sum::<f32>().sqrt().max(f32::EPSILON);
    Some(cry_xyzw_to_blender_wxyz(q.map(|v| v / n)))
}

/// The angle between two rotations, in degrees.
pub fn angle_deg(a: Quat, b: Quat) -> f32 {
    let dot = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum::<f32>().abs().min(1.0);
    2.0 * dot.acos().to_degrees()
}

/// A clip sampled onto a frame grid.
pub struct Sampled {
    pub fps: f32,
    pub frames: usize,
    /// Bone hashes, in the order of `rotations`' inner dimension.
    pub bones: Vec<u32>,
    /// `frames x bones x 4`, `[w, x, y, z]`.
    pub rotations: Vec<f32>,
}

/// Sample every rotation channel `keep` accepts at the clip's own rate.
///
/// Frame `frames - 1` is the clip's last key and frame 0 its first. A looping
/// player shows frames `0..frames - 1` and wraps: on a clip that loops, the
/// last key repeats the first, and drawing both holds the pose for a frame.
pub fn sample(clip: &AnimationClip, keep: impl Fn(&BoneChannel) -> bool) -> Option<Sampled> {
    let (start, end) = frame_range(clip)?;
    let frames = (end - start).round() as usize + 1;
    let channels: Vec<&BoneChannel> =
        clip.channels.iter().filter(|c| !c.rotations.is_empty() && keep(c)).collect();
    let mut rotations = Vec::with_capacity(frames * channels.len() * 4);
    for frame in 0..frames {
        let time = start + frame as f32;
        for channel in &channels {
            rotations.extend_from_slice(&rotation_at(&channel.rotations, time)?);
        }
    }
    Some(Sampled {
        fps: if clip.fps > 0.0 { clip.fps } else { 30.0 },
        frames,
        bones: channels.iter().map(|c| c.bone_hash).collect(),
        rotations,
    })
}

/// How well a clip loops, and how much it moves.
#[derive(Debug, Clone)]
pub struct LoopScore {
    pub frames: usize,
    pub fps: f32,
    /// The widest gap between a bone's first and last rotation, degrees.
    pub gap_deg: f32,
    pub gap_bone: u32,
    /// The furthest any bone strays from its first rotation, degrees.
    pub motion_deg: f32,
    /// The furthest one named bone strays -- the hips, for a clip that turns
    /// the whole body.
    pub watch_deg: f32,
}

/// Score a clip as a loop over the channels `keep` accepts.
pub fn loop_score(clip: &AnimationClip, keep: impl Fn(&BoneChannel) -> bool, watch: u32) -> Option<LoopScore> {
    let sampled = sample(clip, keep)?;
    let n = sampled.bones.len();
    let at = |frame: usize, bone: usize| -> Quat {
        let o = (frame * n + bone) * 4;
        [
            sampled.rotations[o],
            sampled.rotations[o + 1],
            sampled.rotations[o + 2],
            sampled.rotations[o + 3],
        ]
    };
    let last = sampled.frames - 1;
    let (mut gap_deg, mut gap_bone, mut motion_deg, mut watch_deg) = (0.0f32, 0u32, 0.0f32, 0.0f32);
    for (b, &hash) in sampled.bones.iter().enumerate() {
        let gap = angle_deg(at(0, b), at(last, b));
        if gap > gap_deg {
            gap_deg = gap;
            gap_bone = hash;
        }
        for frame in 1..sampled.frames {
            let moved = angle_deg(at(0, b), at(frame, b));
            motion_deg = motion_deg.max(moved);
            if hash == watch {
                watch_deg = watch_deg.max(moved);
            }
        }
    }
    Some(LoopScore { frames: sampled.frames, fps: sampled.fps, gap_deg, gap_bone, motion_deg, watch_deg })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(time: f32, xyzw: [f32; 4]) -> Keyframe<[f32; 4]> {
        Keyframe { time, value: xyzw }
    }

    #[test]
    fn holds_the_end_keys_and_interpolates_between() {
        let half = std::f32::consts::FRAC_1_SQRT_2;
        // Identity at frame 0, 90 degrees about x at frame 10.
        let keys = [key(0.0, [0.0, 0.0, 0.0, 1.0]), key(10.0, [half, 0.0, 0.0, half])];
        assert!(angle_deg(rotation_at(&keys, -5.0).unwrap(), [1.0, 0.0, 0.0, 0.0]) < 1e-3);
        let mid = rotation_at(&keys, 5.0).unwrap();
        assert!((angle_deg(mid, [1.0, 0.0, 0.0, 0.0]) - 45.0).abs() < 0.5, "{mid:?}");
        let end = rotation_at(&keys, 20.0).unwrap();
        assert!((angle_deg(end, [1.0, 0.0, 0.0, 0.0]) - 90.0).abs() < 1e-3);
    }

    #[test]
    fn takes_the_shorter_arc() {
        // The same rotation written with opposite signs must not swing round.
        let keys = [key(0.0, [0.0, 0.0, 0.0, 1.0]), key(2.0, [0.0, 0.0, 0.0, -1.0])];
        let mid = rotation_at(&keys, 1.0).unwrap();
        assert!(angle_deg(mid, [1.0, 0.0, 0.0, 0.0]) < 1e-3, "{mid:?}");
    }
}
