-- =========================================================================
-- CMS PAGES
--
-- Storage for the Blog Builder's "Pages" section: custom service pages
-- (/services/<slug>) and edits to the built-in service pages. One row per
-- page key; the whole page object is kept as JSON exactly as the CMS sends it.
--
-- Purely additive: a new table, nothing existing is touched.
-- =========================================================================

CREATE TABLE "cms_pages" (
    "id" VARCHAR(120) NOT NULL,
    "content" JSONB NOT NULL,
    "updated_by" VARCHAR(180),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cms_pages_pkey" PRIMARY KEY ("id")
);
