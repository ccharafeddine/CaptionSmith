/** True when the event target is a focused form control that should handle its
 *  own keys (so global media/edit shortcuts don't hijack typing, sliders,
 *  selects, or button activation). */
export function isFormControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "BUTTON" ||
    el.isContentEditable
  );
}
