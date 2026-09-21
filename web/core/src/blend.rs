//! Which base layer a blend-mask pixel selects.
//!
//! **This table took four attempts and three of the readings are refuted.** It
//! is not a gradient: the mask is a splat with a ground layer and blue, green
//! and red lerping over it in that order, highest channel winning, and the
//! layers numbered **from the top** -- the natural reading reversed.
//!
//! | mask | layer | | mask | layer |
//! | --- | --- | --- | --- | --- |
//! | black (ground) | BaseLayer4 | | red | BaseLayer1 |
//! | blue | BaseLayer3 | | magenta | BaseLayer1 |
//! | green | BaseLayer2 | | yellow | BaseLayer1 |
//! | cyan | BaseLayer2 | | white | BaseLayer1 |
//!
//! Derived on Corbel Halcyon and confirmed on references it was **not** fitted
//! to: the Sunchaser back (33.0% gold on CIG's store render against 32.9%
//! here), the Sunchaser shoulder pad, and Beacon Undersuit Orange, whose
//! sleeves come out the dusky mauve-brown the reference shows rather than the
//! glossy black anodized metal an earlier table gave them.
//!
//! The readings that failed, so nobody tries them again:
//!
//! * ground to BaseLayer2, green to BaseLayer4 -- inverts Corbel, leaves the
//!   Sunchaser back 13 points short, blackens Beacon's sleeves.
//! * blue to BaseLayer1 -- inverts the Sunchaser shoulder pad.
//! * ground to BaseLayer1, magenta to BaseLayer4 -- renders the Beacon body as
//!   grey anodized metal, 59% metallic.
//! * a plain blue/magenta swap -- puts the pad interior on light rubber where
//!   the reference is charcoal.

/// Base layer index (0-based) for each of the eight saturated mask colours,
/// keyed by `red | green<<1 | blue<<2`.
pub const BLEND_BUCKETS: [usize; 8] = [
    3, // 0b000 black   -> BaseLayer4, the ground
    0, // 0b001 red     -> BaseLayer1
    1, // 0b010 green   -> BaseLayer2
    0, // 0b011 yellow  -> red over green -> BaseLayer1
    2, // 0b100 blue    -> BaseLayer3
    0, // 0b101 magenta -> red over blue  -> BaseLayer1
    1, // 0b110 cyan    -> green over blue -> BaseLayer2
    0, // 0b111 white   -> BaseLayer1
];

/// The bucket a mask pixel falls in. Channels are thresholded at half, because
/// four saturated colours cover 96% of a real armour mask -- it is a selector,
/// not a gradient.
pub fn bucket(rgb: [u8; 3]) -> usize {
    let bit = |c: u8| usize::from(c > 127);
    bit(rgb[0]) | (bit(rgb[1]) << 1) | (bit(rgb[2]) << 2)
}

/// The base layer a mask pixel selects.
pub fn layer_for(rgb: [u8; 3]) -> usize {
    BLEND_BUCKETS[bucket(rgb)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ground_is_the_last_layer_not_the_first() {
        // The single most consequential entry: reading black as BaseLayer1
        // rendered the Beacon body as grey anodized metal.
        assert_eq!(layer_for([0, 0, 0]), 3);
    }

    #[test]
    fn the_primaries_map_as_settled() {
        assert_eq!(layer_for([255, 0, 0]), 0, "red");
        assert_eq!(layer_for([0, 255, 0]), 1, "green");
        assert_eq!(layer_for([0, 0, 255]), 2, "blue");
    }

    #[test]
    fn a_secondary_takes_its_highest_channel() {
        // Red beats green beats blue, so anything with red is BaseLayer1.
        assert_eq!(layer_for([255, 255, 0]), 0, "yellow is red over green");
        assert_eq!(layer_for([255, 0, 255]), 0, "magenta is red over blue");
        assert_eq!(layer_for([255, 255, 255]), 0, "white");
        // Cyan has no red, so green wins.
        assert_eq!(layer_for([0, 255, 255]), 1, "cyan is green over blue");
    }

    #[test]
    fn blue_is_not_the_first_layer() {
        // The second refuted reading. It inverts the Sunchaser shoulder pad,
        // whose mask has blue on for 99.9% of the pad.
        assert_ne!(layer_for([0, 0, 255]), 0);
    }

    #[test]
    fn channels_threshold_at_half() {
        assert_eq!(bucket([128, 0, 0]), 0b001);
        assert_eq!(bucket([127, 0, 0]), 0b000);
    }
}
