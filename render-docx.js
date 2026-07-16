// resumeJsonToDocx(resume, styles) -> Promise<Blob>
// Uses the `docx` UMD global from lib/docx.min.js.

function resumeJsonToDocx(resume, styles) {
  const D = docx;
  const accent = styles.accentColor.replace("#", "");
  const muted = styles.mutedColor.replace("#", "");
  const halfPt = (pt) => Math.round(pt * 2);
  // Links keep the full URL as the target but display protocol/"www."-stripped.
  const prettyUrl = (u) =>
    String(u).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const ensureHttp = (u) => (/^https?:\/\//i.test(u) ? u : "https://" + u);

  const children = [];

  // Name
  children.push(
    new D.Paragraph({
      children: [
        new D.TextRun({
          text: resume.name || "",
          bold: true,
          color: accent,
          size: halfPt(styles.namePt),
        }),
      ],
      spacing: { after: 40 },
    })
  );

  // Contact line — URLs render as clickable links showing the stripped form
  // (github.com/x) while pointing at the full URL.
  const c = resume.contact || {};
  const contactRuns = [];
  const mutedRun = (text) => new D.TextRun({ text, color: muted, size: halfPt(styles.smallPt) });
  const pushContact = (node) => {
    if (contactRuns.length) contactRuns.push(mutedRun("   ·   "));
    contactRuns.push(node);
  };
  if (c.email) pushContact(mutedRun(c.email));
  if (c.phone) pushContact(mutedRun(c.phone));
  // contact location intentionally not shown (remote-first)
  (c.links || []).forEach((l) =>
    pushContact(
      new D.ExternalHyperlink({ link: ensureHttp(l), children: [mutedRun(prettyUrl(l))] })
    )
  );
  if (contactRuns.length) {
    // after: 160 twentieths = 8pt, matching the PDF contact margin
    children.push(new D.Paragraph({ children: contactRuns, spacing: { after: 160 } }));
  }

  function sectionHeader(title) {
    return new D.Paragraph({
      children: [
        new D.TextRun({
          text: title,
          smallCaps: true,
          bold: true,
          color: accent,
          size: halfPt(styles.headerPt),
        }),
      ],
      spacing: { before: 200, after: 80 },
      border: {
        bottom: { color: accent, space: 2, style: D.BorderStyle.SINGLE, size: 4 },
      },
    });
  }

  function bodyParagraph(text, opts = {}) {
    return new D.Paragraph({
      children: [new D.TextRun({ text, size: halfPt(styles.bodyPt) })],
      spacing: { after: opts.after ?? 60 },
    });
  }

  function bulletParagraph(text, url) {
    // When a URL is present, the bullet text itself is the clickable link
    // (accent-colored as the visual cue).
    const textRun = new D.TextRun({
      text,
      size: halfPt(styles.bodyPt),
      ...(url ? { color: accent } : {}),
    });
    const runs = url
      ? [new D.ExternalHyperlink({ link: ensureHttp(url), children: [textRun] })]
      : [textRun];
    return new D.Paragraph({
      children: runs,
      bullet: { level: 0 },
      spacing: { after: 30 },
    });
  }

  // Heading line with right-aligned dates via a right tab stop. `url`, if set,
  // makes the bold title text itself the clickable link (accent-colored).
  function entryHeading(leftBold, leftPlain, right, url) {
    const titleRun = new D.TextRun({
      text: leftBold,
      bold: true,
      size: halfPt(styles.bodyPt),
      ...(url ? { color: accent } : {}),
    });
    const runs = [
      url ? new D.ExternalHyperlink({ link: ensureHttp(url), children: [titleRun] }) : titleRun,
    ];
    if (leftPlain) {
      runs.push(new D.TextRun({ text: leftPlain, size: halfPt(styles.bodyPt) }));
    }
    if (right) {
      runs.push(
        new D.TextRun({ text: "\t" + right, color: muted, size: halfPt(styles.smallPt) })
      );
    }
    return new D.Paragraph({
      children: runs,
      tabStops: [{ type: D.TabStopType.RIGHT, position: D.TabStopPosition.MAX }],
      spacing: { before: 80, after: 40 },
    });
  }

  // Summary
  if (resume.summary) {
    children.push(sectionHeader("Summary"));
    children.push(bodyParagraph(resume.summary, { after: 80 }));
  }

  // Skills
  if (Array.isArray(resume.skills) && resume.skills.length) {
    children.push(sectionHeader("Skills"));
    resume.skills.forEach((group) => {
      children.push(
        new D.Paragraph({
          children: [
            new D.TextRun({
              text: group.category ? group.category + ":  " : "",
              bold: true,
              size: halfPt(styles.bodyPt),
            }),
            new D.TextRun({
              text: (group.items || []).join(", "),
              size: halfPt(styles.bodyPt),
            }),
          ],
          spacing: { after: 40 },
        })
      );
    });
  }

  // Experience
  if (Array.isArray(resume.experience) && resume.experience.length) {
    children.push(sectionHeader("Experience"));
    resume.experience.forEach((role) => {
      const companyBits = [role.company, role.location].filter(Boolean).join(" · ");
      children.push(
        entryHeading(role.title || "", companyBits ? " — " + companyBits : "", role.dates || "", role.url)
      );
      (role.bullets || []).forEach((b) => children.push(bulletParagraph(b)));
    });
  }

  // Projects
  if (Array.isArray(resume.projects) && resume.projects.length) {
    children.push(sectionHeader("Projects"));
    resume.projects.forEach((proj) => {
      children.push(
        entryHeading(proj.name || "", proj.description ? " — " + proj.description : "", "", proj.url)
      );
      (proj.bullets || []).forEach((b) => children.push(bulletParagraph(b)));
    });
  }

  // Education
  if (Array.isArray(resume.education) && resume.education.length) {
    children.push(sectionHeader("Education"));
    resume.education.forEach((edu) => {
      children.push(
        entryHeading(
          edu.institution || "",
          edu.degree ? " — " + edu.degree : "",
          edu.dates || ""
        )
      );
      if (edu.details) children.push(bodyParagraph(edu.details));
    });
  }

  // Certifications — each is { name, url } (or a bare string for older data).
  if (Array.isArray(resume.certifications) && resume.certifications.length) {
    children.push(sectionHeader("Certifications"));
    resume.certifications.forEach((cert) => {
      const c = typeof cert === "string" ? { name: cert } : cert || {};
      children.push(bulletParagraph(c.name || "", c.url));
    });
  }

  // Pagination is calibrated to the PDF renderer (the canonical artifact):
  // - margins 840 twips = 42pt on all sides, matching the PDF's pageMargins,
  //   so both have an identical 528pt text width on LETTER.
  // - line pitch "at least" 262 twentieths = 13.1pt, matching the PDF's
  //   10.5pt x 1.25 lineHeight ("atLeast" so larger runs like the name still
  //   grow their line instead of clipping).
  // Residual page-length differences come only from font glyph widths
  // (Calibri here vs pdfmake's Roboto).
  const doc = new D.Document({
    styles: {
      default: {
        document: {
          run: { font: styles.fontDocx, size: halfPt(styles.bodyPt) },
          paragraph: { spacing: { line: 262, lineRule: "atLeast" } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 840, bottom: 840, left: 840, right: 840 },
          },
        },
        children,
      },
    ],
  });

  return D.Packer.toBlob(doc);
}
