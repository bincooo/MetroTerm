/** Text with the (case-insensitive) search match marked; `query` is lower case. */
export function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="filer-match">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}
