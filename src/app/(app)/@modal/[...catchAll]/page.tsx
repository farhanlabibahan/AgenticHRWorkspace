// Any in-app navigation that isn't to a candidate clears the modal slot.
// Without this, a parallel slot keeps its last state on soft navigation, so
// following a link out of the profile drawer (e.g. "← Pipeline") changed the
// URL but left the drawer open over the new page.
export default function CatchAll() {
  return null;
}
