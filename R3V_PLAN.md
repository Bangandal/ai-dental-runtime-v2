# R3v bounded model/tool iterator

- Preserve existing booking legality.
- Preserve hard max-3 model-call budget.
- Move model/tool sequencing into one iterator.
- Keep tool execution in executeRuntimeTurnToolBatch.
- Keep finalization/fallback policy outside the iterator.
- Remove temporary migration files before merge.
