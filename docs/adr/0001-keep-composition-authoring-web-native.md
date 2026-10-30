# Keep composition authoring web-native

**Status:** Amended by [ADR-0007](./0007-make-html-documents-the-composition-unit.md).

Frameyard will use ordinary HTML, CSS, and native JavaScript modules with a framework-agnostic composition lifecycle rather than coupling the core to React or another UI framework. This preserves the project's primary differentiator and avoids freezing a UI-framework dependency into the public composition contract; adapters may be added later without changing that contract.
