# Produce local AI assets outside rendering

Frameyard integrates local speech synthesis and transcription as explicit CLI operations that freeze ordinary project assets before composition loading; model inference is never part of frame production. This separates variable model and hardware behavior from deterministic rendering and keeps the AI integrations optional, at the cost of requiring users and agents to manage generated inputs and their provenance explicitly.
