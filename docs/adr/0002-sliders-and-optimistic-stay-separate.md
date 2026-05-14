# Sliders and optimistic stay separate

`admin/app/sliders.js` and `admin/app/optimistic.js` both encode "local-first
then reconcile," but the shapes differ: sliders coalesces value-with-target
drags with intermediate frames and a queue; optimistic does fire-and-rollback
for discrete actions. They are two adapters of two different concepts, not one
concept with two adapters. We considered merging and rejected: a unified
module would need both shapes behind one interface, widening it without
giving callers more leverage. Future architecture reviews should not
re-suggest the merge; one-line `// see also` comments cross-reference the two
files at their tops.
