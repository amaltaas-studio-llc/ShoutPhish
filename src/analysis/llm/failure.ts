/**
 * A semantic attempt that failed for a reason worth showing in a diagnostic report.
 *
 * The report is pasted into public issues, so a reason may reach it only if it is known to hold nothing
 * from the mail or from a model's output. This class is how the engine tells such a reason apart from
 * any other exception: an adapter throws one only with text it wrote itself, such as the service worker's
 * fixed explanations of why a model server could not be used. Any other error, a browser API rejection
 * included, still records `error` but carries no reason, since its message is not ours to vouch for.
 */
export class SemanticFailure extends Error {
  override readonly name = 'SemanticFailure';
}
