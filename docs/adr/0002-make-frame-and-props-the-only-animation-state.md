# Make frame and props the only animation state

Every composition frame must be seek-safe and derivable from its integer frame number and immutable props, with asynchronous work completed before frame production. Frameyard rejects wall-clock animation and history-dependent updates because deterministic seeking is what makes reliable scrubbing, independent frame rendering, and future parallelism possible.
