// resumeJsonToPdf(resume, styles) -> Promise<Blob>
// measureResumePages(resume, styles, heightScale) -> Promise<number>
// Uses the `pdfMake` UMD global from lib/pdfmake.min.js (+ vfs_fonts.js).
// Declarative document definition -> real selectable text.

function buildResumeDocDefinition(resume, styles) {
  const accent = styles.accentColor;
  const muted = styles.mutedColor;
  // LETTER page (612pt) minus left+right margins.
  const MARGIN = 42;
  const CONTENT_WIDTH = 612 - MARGIN * 2;
  // Links keep the full URL as the target but display protocol/"www."-stripped.
  const prettyUrl = (u) =>
    String(u).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const ensureHttp = (u) => (/^https?:\/\//i.test(u) ? u : "https://" + u);

  const content = [];

  // Name
  content.push({
    text: resume.name || "",
    fontSize: styles.namePt,
    bold: true,
    color: accent,
    margin: [0, 0, 0, 2],
  });

  // Contact line — URLs render as clickable links showing the stripped form
  // (github.com/x) while pointing at the full URL.
  const c = resume.contact || {};
  const contactParts = [];
  const pushContact = (node) => {
    if (contactParts.length) contactParts.push("   ·   ");
    contactParts.push(node);
  };
  if (c.email) pushContact(c.email);
  if (c.phone) pushContact(c.phone);
  // contact location intentionally not shown (remote-first)
  (c.links || []).forEach((l) => pushContact({ text: prettyUrl(l), link: ensureHttp(l) }));
  if (contactParts.length) {
    content.push({
      text: contactParts,
      fontSize: styles.smallPt,
      color: muted,
      margin: [0, 0, 0, 8],
    });
  }

  function sectionHeader(title) {
    return [
      {
        text: title.toUpperCase(),
        fontSize: styles.headerPt,
        bold: true,
        color: accent,
        characterSpacing: 0.6,
        margin: [0, 10, 0, 0],
      },
      {
        canvas: [
          {
            type: "line",
            x1: 0,
            y1: 0,
            x2: CONTENT_WIDTH,
            y2: 0,
            lineWidth: 0.75,
            lineColor: accent,
          },
        ],
        margin: [0, 2, 0, 5],
      },
    ];
  }

  // `url`, if set, makes the bold title text itself the clickable link
  // (accent-colored as the visual cue).
  function entryHeading(leftBold, leftPlain, right, url) {
    const title = { text: leftBold, bold: true };
    if (url) {
      title.link = ensureHttp(url);
      title.color = accent;
    }
    return {
      columns: [
        {
          width: "*",
          text: [title, leftPlain ? { text: leftPlain } : ""],
          fontSize: styles.bodyPt,
        },
        right
          ? {
              width: "auto",
              text: right,
              alignment: "right",
              fontSize: styles.smallPt,
              color: muted,
            }
          : { width: "auto", text: "" },
      ],
      margin: [0, 4, 0, 2],
    };
  }

  function bullets(items) {
    return {
      ul: items,
      fontSize: styles.bodyPt,
      margin: [2, 0, 0, 3],
    };
  }

  // Summary
  if (resume.summary) {
    content.push(...sectionHeader("Summary"));
    content.push({ text: resume.summary, fontSize: styles.bodyPt, margin: [0, 0, 0, 4] });
  }

  // Skills
  if (Array.isArray(resume.skills) && resume.skills.length) {
    content.push(...sectionHeader("Skills"));
    resume.skills.forEach((group) => {
      content.push({
        text: [
          group.category ? { text: group.category + ":  ", bold: true } : "",
          { text: (group.items || []).join(", ") },
        ],
        fontSize: styles.bodyPt,
        margin: [0, 0, 0, 2],
      });
    });
  }

  // Experience
  if (Array.isArray(resume.experience) && resume.experience.length) {
    content.push(...sectionHeader("Experience"));
    resume.experience.forEach((role) => {
      const companyBits = [role.company, role.location].filter(Boolean).join(" · ");
      content.push(
        entryHeading(role.title || "", companyBits ? " — " + companyBits : "", role.dates || "", role.url)
      );
      if ((role.bullets || []).length) content.push(bullets(role.bullets));
    });
  }

  // Projects
  if (Array.isArray(resume.projects) && resume.projects.length) {
    content.push(...sectionHeader("Projects"));
    resume.projects.forEach((proj) => {
      content.push(
        entryHeading(proj.name || "", proj.description ? " — " + proj.description : "", "", proj.url)
      );
      if ((proj.bullets || []).length) content.push(bullets(proj.bullets));
    });
  }

  // Education
  if (Array.isArray(resume.education) && resume.education.length) {
    content.push(...sectionHeader("Education"));
    resume.education.forEach((edu) => {
      content.push(
        entryHeading(edu.institution || "", edu.degree ? " — " + edu.degree : "", edu.dates || "")
      );
      if (edu.details) {
        content.push({ text: edu.details, fontSize: styles.bodyPt, margin: [0, 0, 0, 2] });
      }
    });
  }

  // Certifications — each is { name, url } (or a bare string for older data).
  // The name itself is the clickable link when a URL is present.
  if (Array.isArray(resume.certifications) && resume.certifications.length) {
    content.push(...sectionHeader("Certifications"));
    const certItems = resume.certifications.map((cert) => {
      const c = typeof cert === "string" ? { name: cert } : cert || {};
      return c.url ? { text: c.name || "", link: ensureHttp(c.url), color: accent } : c.name || "";
    });
    content.push(bullets(certItems));
  }

  return {
    pageSize: "LETTER",
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
    defaultStyle: {
      fontSize: styles.bodyPt,
      lineHeight: 1.25,
      color: styles.bodyColor,
    },
    content,
  };
}

function resumeJsonToPdf(resume, styles) {
  const docDefinition = buildResumeDocDefinition(resume, styles);
  return new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(docDefinition).getBlob(resolve);
    } catch (err) {
      reject(err);
    }
  });
}

// Renders the resume in memory (nothing downloaded) and reports how many
// pages it occupies. `heightScale` > 1 lays it out on a taller virtual page
// of the same width — used to estimate how full the final page is: if the
// content fits on fewer tall pages than real pages, the last page is a
// fragment. Purely local; costs no API tokens.
function measureResumePages(resume, styles, heightScale = 1) {
  const docDefinition = buildResumeDocDefinition(resume, styles);
  if (heightScale !== 1) {
    // LETTER is 612 x 792 pt.
    docDefinition.pageSize = { width: 612, height: Math.round(792 * heightScale) };
  }
  let pages = 0;
  // pdfmake invokes the footer for every page during layout with the total
  // page count — capturing it here is the supported way to read the count.
  docDefinition.footer = (currentPage, pageCount) => {
    pages = pageCount;
    return null;
  };
  return new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(docDefinition).getBlob(() => resolve(pages));
    } catch (err) {
      reject(err);
    }
  });
}
