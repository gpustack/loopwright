const GENERIC_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /ghs_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /TYPESAFE_API_KEY/g,
  /OPENAI_API_KEY/g,
  /ANTHROPIC_API_KEY/g,
  /STARTLUX_API_KEY/g,
  /PERPLEXITY_API_KEY/g,
  /CLOUDFLARE_API_TOKEN/g,
  /LIQUID_API_KEY/g,
  /AZURE_API_KEY/g,
  /MICROSOFT_DECISION_API_KEY/g,
  /AWS_SECRET_ACCESS_KEY/g,
]);
const MIN_FORM_LENGTH = 8;

/**
 * Decision-neutral credential tracker: registers secret material in raw, JSON-escaped, URL-encoded, and
 * base64 forms and reports or replaces every form plus generic token patterns. It never throws; callers
 * decide how to treat detected secrets.
 */
export class SecretScrubber {
  readonly #forms = new Set<string>();

  register(secret: string): void {
    if (typeof secret !== 'string' || secret.length === 0) return;
    const forms = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret, 'utf8').toString('base64'),
    ];
    for (const form of forms) {
      if (form.length >= MIN_FORM_LENGTH) this.#forms.add(form);
    }
  }

  /** Replace every tracked credential form and generic token pattern with `[scrubbed]`. */
  scrub(text: string): string {
    let output = text;
    for (const form of this.#forms) {
      output = output.split(form).join('[scrubbed]');
    }
    for (const pattern of GENERIC_SECRET_PATTERNS) {
      output = output.replace(new RegExp(pattern.source, 'g'), '[scrubbed]');
    }
    return output;
  }

  /** Return true when any tracked credential form or generic token pattern appears in the value. */
  containsSecret(value: string): boolean {
    for (const form of this.#forms) {
      if (value.includes(form)) return true;
    }
    for (const pattern of GENERIC_SECRET_PATTERNS) {
      if (new RegExp(pattern.source).test(value)) return true;
    }
    return false;
  }
}
