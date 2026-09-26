// Parallel-route slots without a loading UI block the sibling page from
// streaming. Render nothing — the modal is empty on ordinary navigations.
export default function Loading() {
  return null;
}
