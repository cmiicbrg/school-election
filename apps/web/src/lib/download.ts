// Saving a response as a file, free of the DOM where it can be: the file
// name a Content-Disposition header gives, which the page uses for the
// link it clicks for the person.

/** The file name of an attachment, or null without one; quoted or bare, ASCII only, as the API writes it. */
export function fileNameOf(contentDisposition: string | null): string | null {
  const match = /attachment;\s*filename=(?:"([^"]+)"|([^\s;]+))/i.exec(contentDisposition ?? '')
  const name = match?.[1] ?? match?.[2] ?? null
  return name !== null && /^[\w.-]+$/.test(name) ? name : null
}
