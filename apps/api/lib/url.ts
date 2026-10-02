/** The path of a request URL, without query string or fragment. */
export function pathOf(url: string): string {
  const end = url.search(/[?#]/)
  return end === -1 ? url : url.slice(0, end)
}
