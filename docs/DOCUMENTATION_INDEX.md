# Documentation Index

Canonical index of `docs/` content. Consult this file before loading deep documentation.

Maintenance rule:
- Update this index in the same change whenever docs are added, removed, or renamed.
- Keep each summary at 300 characters or fewer.

| Path | Domain | Summary |
|---|---|---|
| `docs/APPLE-CONTAINER-NETWORKING.md` | runtime/networking | Apple Container networking setup on macOS 26 for NanoClaw, including host/container connectivity checks, expected network behavior, and troubleshooting steps for local containerized development. |
| `docs/DEBUG_CHECKLIST.md` | operations/debug | Operational debug checklist for NanoClaw incidents: startup failures, channel issues, container/runtime checks, logs to inspect, and stepwise diagnostics to isolate regressions quickly. |
| `docs/MESH_V1.md` | architecture/distributed | Mesh V1 design for U56E orchestrator plus Dell executor setup, documenting role split, routing model, operational flow, and expected behavior for distributed execution. |
| `docs/nanoclaw-architecture-final.md` | architecture/skills | Finalized NanoClaw skills architecture: extension model, layering boundaries, and how skills modify the system while preserving a minimal core and predictable integration flow. |
| `docs/nanorepo-architecture.md` | architecture/overview | High-level architecture overview of NanoClaw as a minimal core extended through skills that change real code paths, runtime behavior, and channel integrations. |
| `docs/REQUIREMENTS.md` | product/requirements | Project requirements and core expectations for NanoClaw behavior, integration capabilities, and operational constraints used as baseline implementation targets. |
| `docs/SDK_DEEP_DIVE.md` | sdk/internals | Deep technical reference for Claude Agent SDK usage in NanoClaw, including query loop behavior, hook events, tool execution semantics, and lifecycle details. |
| `docs/SECURITY.md` | security | Security model and threat controls for NanoClaw, including path/mount validation, isolation assumptions, and guardrails that protect runtime and host boundaries. |
| `docs/SPEC.md` | product/spec | Detailed system specification describing module boundaries, data flow, core components, and intended behavior across runtime, routing, and container interactions. |
| `docs/JOHN KIM META/Agentic Engineering.txt` | meta/transcript | Transcript covering JK's five pillars of agentic engineering: context engineering, validation, tooling/friction removal, agentic codebases, and compound engineering practices. |
| `docs/JOHN KIM META/AGENTS.md` | meta/policy | JK-aligned operating manual for this repo with pillar-driven rules, validation evidence contract, friction loop, hooks policy, parallel session controls, and context/indexing requirements. |
| `docs/JOHN KIM META/John Kim Meta Claude.txt` | meta/transcript | Transcript with workflow tips around second-brain context, skills, validation loops, hooks, and multi-instance operation patterns for high-throughput agentic development. |
| `docs/PROJECTCONTEXT_BOOTSTRAP.md` | process/context | Procedure for creating `projectcontext.md` late in a project using recent commit mining, docs extraction, conflict resolution, and a required intake template for reproducible bootstrap. |
| `docs/DOCUMENTATION_INDEX.md` | process/indexing | This index file: canonical map of docs content with domain tags and concise summaries for fast retrieval and low-context-load navigation. |
