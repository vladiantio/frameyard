# Make frame and props the only animation state

**Amended by [ADR-0010](./0010-make-timelines-the-render-unit.md).** Timeline frames are the master clock; each active clip is seeked to its own composition frame, and each composition instance has its own immutable props.

Every composition frame must be seek-safe and derivable from its integer frame number and immutable props, with asynchronous work completed before frame production. Frameyard rejects wall-clock animation and history-dependent updates because deterministic seeking is what makes reliable scrubbing, independent frame rendering, and future parallelism possible.
