window.HandbookCloudFormat = {
  split(text, limit = 180000) {
    const parts = []
    for (let at = 0; at < text.length;) {
      let end = Math.min(at + limit, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      parts.push(text.slice(at, end)); at = end
    }
    return parts
  }
}
