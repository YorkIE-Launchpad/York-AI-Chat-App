#!/usr/bin/env python3
"""Generate Monthly Growth Assessment PDF for York IE (york.ie website)."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable, ListFlowable, ListItem
)
from reportlab.pdfgen import canvas
from reportlab.platypus.flowables import KeepTogether

OUTPUT_PATH = "outputs/York_IE_Monthly_Growth_Assessment.pdf"

# ---------- Styles ----------
styles = getSampleStyleSheet()

NAVY = colors.HexColor("#0B2545")
ACCENT = colors.HexColor("#1B6CA8")
GREEN = colors.HexColor("#1E8449")
RED = colors.HexColor("#B03A2E")
GREY = colors.HexColor("#5D6D7E")
LIGHT_BG = colors.HexColor("#F4F6F7")

title_style = ParagraphStyle(
    "TitleStyle", parent=styles["Title"], fontSize=24, textColor=NAVY,
    spaceAfter=6, alignment=TA_LEFT
)
subtitle_style = ParagraphStyle(
    "SubtitleStyle", parent=styles["Normal"], fontSize=12, textColor=GREY,
    spaceAfter=20
)
h1_style = ParagraphStyle(
    "H1", parent=styles["Heading1"], fontSize=16, textColor=NAVY,
    spaceBefore=18, spaceAfter=10, borderPadding=0
)
h2_style = ParagraphStyle(
    "H2", parent=styles["Heading2"], fontSize=13, textColor=ACCENT,
    spaceBefore=12, spaceAfter=6
)
body_style = ParagraphStyle(
    "Body", parent=styles["Normal"], fontSize=10.2, leading=15,
    textColor=colors.HexColor("#1C2833"), spaceAfter=8, alignment=TA_LEFT
)
bullet_style = ParagraphStyle(
    "Bullet", parent=body_style, leftIndent=14, spaceAfter=6
)
label_style = ParagraphStyle(
    "Label", parent=styles["Normal"], fontSize=9, textColor=colors.white,
    alignment=TA_CENTER
)
finding_head_style = ParagraphStyle(
    "FindingHead", parent=styles["Heading3"], fontSize=11.5, textColor=NAVY,
    spaceBefore=10, spaceAfter=4
)
finding_sub_style = ParagraphStyle(
    "FindingSub", parent=styles["Normal"], fontSize=9, textColor=ACCENT,
    spaceBefore=4, spaceAfter=2, fontName="Helvetica-Bold"
)
footer_style = ParagraphStyle(
    "Footer", parent=styles["Normal"], fontSize=8, textColor=GREY
)

def status_badge(status):
    color_map = {
        "Active": GREEN,
        "Data Source Unavailable": RED,
    }
    return color_map.get(status, GREY)


# ---------- Content Data ----------

EXEC_NARRATIVE = (
    "Marketing performance across the past 30 days at York IE shows a business generating steady "
    "organic demand alongside a data integrity issue that inflates the headline traffic story. "
    "Underlying, non-spike days point to healthy fundamentals: consistent session volume in the "
    "350-800 range, conversion counts holding between 20 and 70 per day, and LinkedIn follower "
    "growth advancing without paid support.<br/><br/>"
    "Search visibility expanded materially during the period, with the homepage and careers page "
    "both more than doubling impressions and improving average ranking position by roughly 30 to "
    "43 percent. Paid acquisition remains entirely inactive: Google Ads carried zero impressions, "
    "clicks, and spend across all 30 days despite an active, healthy connection. Growth today is "
    "being carried by organic channels alone, and a five-day traffic anomaly (July 14 to 19) "
    "requires data engineering attention before it factors into any board-level growth narrative."
)

OUTLOOK = (
    "Momentum into the next period depends on converting the organic search visibility gains into "
    "qualified pipeline rather than raw traffic, since the primary expansion lever right now is "
    "content and SEO, not paid media. The biggest commercial uncertainty is data integrity: until "
    "the July traffic spike and the zero branded-impressions reporting gap are resolved, leadership "
    "cannot reliably size real demand growth. Recommend prioritizing an analytics audit ahead of "
    "any paid media reactivation decision."
)

WINS = [
    "Homepage organic clicks grew 159 percent and average ranking position improved from 5.3 to "
    "3.0, confirming stronger discoverability for the primary conversion surface.",
    "Careers page impressions grew 209 percent with clicks up 192 percent, evidencing strong "
    "employer-brand search demand ahead of any paid hiring spend.",
    "LinkedIn organic added a net 265 followers (604 gained, 339 lost) over 30 days on zero paid "
    "spend, sustaining brand reach without budget allocation.",
    "Baseline GA4 conversion volume held steady in the 20 to 70 per day range across "
    "non-anomalous days, indicating the core demand engine is stable independent of the traffic spike.",
]

RISKS = [
    "A five-day session spike (July 14 to 19, peaking at 2,406 sessions and 18,189 pageviews in a "
    "single day) shows session and pageview metrics rising far faster than conversions, a pattern "
    "consistent with bot or referral-spam traffic rather than genuine demand and one that will "
    "distort any trend reporting built on this window.",
    "Google Search Console is reporting zero branded impressions for the full 30-day period, an "
    "implausible result for an established company name that signals a tracking or "
    "query-classification defect masking true brand-search demand.",
    "Google Ads carried zero impressions, clicks, and spend for 30 consecutive days despite a "
    "healthy platform connection, leaving paid search as a fully dormant acquisition channel and "
    "creating single-channel dependency on organic traffic.",
    "Search Console shows several high-impression, near-zero-click queries (11,039 impressions on "
    "\u201cproduct development\u201d returned 1 click; 9,506 impressions on \u201cprepared\u201d "
    "returned 0 clicks), indicating meaningful search visibility is not converting into site visits.",
]

PRIORITIES = [
    "Commission a GA4 and GSC data integrity audit to isolate the July 14 to 19 traffic anomaly and "
    "the zero branded-impressions defect before using recent trend data for planning.",
    "Reactivate a scoped Google Ads campaign to test paid search performance against the newly "
    "strengthened organic rankings on homepage and careers pages.",
    "Optimize meta titles and descriptions for the identified zero-click, high-impression queries to "
    "lift CTR without additional content investment.",
    "Formalize the LinkedIn organic playbook that produced follower and reach growth, since it is "
    "currently the only channel generating unpaid, verifiable growth.",
]

CHANNELS = [
    {
        "name": "Google Analytics 4 (Traffic & Engagement)",
        "status": "Active",
        "summary": (
            "Site engagement outside the anomalous window remained stable, with engaged sessions "
            "and conversion counts holding consistent day-to-day patterns. Pipeline generation "
            "efficiency, measured by conversions per session, softened sharply during the July 14 to "
            "19 window even as raw session counts quadrupled, indicating the surge added volume "
            "without adding qualified visitor intent. Direct channel sessions carried nearly all of the "
            "spike, while Organic Search and Organic Social sessions stayed within normal range "
            "throughout, isolating the anomaly to a single attribution bucket."
        ),
    },
    {
        "name": "Google Search Console (Organic Search / SEO)",
        "status": "Active",
        "summary": (
            "Search visibility expanded broadly across brand-owned pages, with the homepage, "
            "careers, about, and connect pages each posting impression and click gains above 150 "
            "percent and average position improvements between 30 and 43 percent. Free traffic "
            "capture (clicks) grew to 4,171 against 361,136 impressions, a 1.15 percent CTR that lags "
            "the visibility gain, meaning prospecting reach is expanding faster than free traffic "
            "conversion. Branded impressions reporting at zero for the full period is a data "
            "classification issue, not an indication of missing brand search demand."
        ),
    },
    {
        "name": "Google Ads (Paid Search)",
        "status": "Active",
        "summary": (
            "Paid search acquisition was fully dormant for the entire 30-day period. Impressions, "
            "clicks, and spend recorded zero every day despite the account connection remaining "
            "healthy, meaning customer acquisition efficiency cannot be evaluated and no CPL "
            "benchmark exists. The channel is technically ready but commercially inactive, leaving "
            "all paid-acquisition upside on the table."
        ),
    },
    {
        "name": "LinkedIn Paid",
        "status": "Data Source Unavailable",
        "summary": None,
    },
    {
        "name": "LinkedIn Organic",
        "status": "Active",
        "summary": (
            "Audience growth was positive and consistent, with followers increasing from 21,872 to "
            "22,830 (604 gained, 339 lost) alongside 123,037 impressions and 13,143 clicks over 30 "
            "days. Blended engagement rate of 12.07 percent reflects healthy organic social "
            "engagement quality. One single-day anomaly on July 1 recorded 3,772 clicks against "
            "typical daily volumes of 100 to 900, a data quality flag rather than a genuine "
            "engagement event."
        ),
    },
]

FINDINGS = [
    {
        "title": "GA4 Traffic Anomaly (July 14\u201319)",
        "strategic": (
            "Sessions jumped from a 350 to 800 daily baseline to a peak of 2,406 on July 18, with "
            "pageviews reaching 12,153 and 18,189 on consecutive days and pages-per-session climbing "
            "to 5.05 and 9.41, several multiples above the normal 2.0 range. Nearly all incremental "
            "volume routed through the Direct channel (2,031 and 1,717 sessions versus a typical 130 "
            "to 250), while Organic Search and Organic Social held steady. Average session duration "
            "hitting 1,360 seconds on July 19 is not consistent with genuine human browsing behavior."
        ),
        "business": (
            "Conversions on the two peak days (40 and 18) came in lower than several normal-volume "
            "days earlier in the period (53 and 71 conversions on lower-traffic days), meaning the "
            "spike diluted conversion efficiency rather than expanding the demand pool. Any pipeline "
            "generation metric calculated across this window will understate true conversion rate "
            "and overstate top-of-funnel reach."
        ),
        "exec": (
            "Evidence clearly demonstrates the spike originates from a non-marketing source, most "
            "likely bot traffic, a crawler, or a referral integration issue routed through Direct. "
            "Leadership should exclude July 14 to 19 from trend reporting until analytics confirms "
            "the source, and monitor pages-per-session and average session duration as the primary "
            "detection metrics for recurrence."
        ),
    },
    {
        "title": "GSC Visibility Surge (Core Pages)",
        "strategic": (
            "Homepage, careers, about, and connect pages each posted impression gains of 150 to 209 "
            "percent and click gains of 159 to 393 percent against the prior comparable period, "
            "paired with average position improvements of 30 to 51 percent. The consistency of the "
            "lift across the site's core brand pages, rather than a single content asset, points to "
            "a broad ranking or indexing shift rather than an isolated content win."
        ),
        "business": (
            "Stronger rankings on the homepage and careers page directly expand new customer "
            "discovery and candidate discovery at the top of the funnel without added spend. Because "
            "CTR growth trailed impression growth, much of this visibility gain has not yet converted "
            "into proportional free traffic, representing unrealized prospecting reach."
        ),
        "exec": (
            "Observed trends indicate a genuine and durable improvement in organic search standing "
            "for York IE's core brand pages. Leadership should monitor whether this visibility gain "
            "converts into inbound lead volume over the next reporting cycle and consider content "
            "refreshes to close the gap between impression growth and click growth."
        ),
    },
    {
        "title": "GSC CTR Gap (High Impressions, Low Clicks)",
        "strategic": (
            "Multiple high-impression queries returned negligible clicks: \u201cproduct "
            "development\u201d drew 11,039 impressions for 1 click, \u201cprepared\u201d drew 9,506 "
            "impressions for 0 clicks, and both technical SEO audit checklist variants drew a "
            "combined 2,436 impressions for 0 clicks. Average position for most of these terms sits "
            "between 5 and 16, meaning the pages are ranking but not earning clicks from searchers."
        ),
        "business": (
            "These queries represent prospecting reach that is currently going uncaptured. Improving "
            "snippet relevance or title framing on the underlying pages could convert existing "
            "impression volume into free traffic without additional content production or media "
            "spend."
        ),
        "exec": (
            "Channel performance points to a low-cost optimization opportunity concentrated in a "
            "small set of pages. Leadership should direct the content team to test revised titles and "
            "meta descriptions on these specific queries and track CTR lift as the success metric for "
            "the next 30 days."
        ),
    },
    {
        "title": "Google Ads Dormant Channel",
        "strategic": (
            "Google Ads returned zero impressions, zero clicks, and zero spend across all 30 days "
            "in the reporting window, despite the account connection status showing healthy and "
            "actively syncing. No campaigns were returned in the campaign-level data pull, "
            "confirming the account is configured but not running any active paid search activity."
        ),
        "business": (
            "With paid search fully inactive, all current customer acquisition relies on organic "
            "search and organic social, concentrating channel risk. There is no CPL or paid "
            "acquisition efficiency baseline available, which limits leadership's ability to compare "
            "paid versus organic acquisition cost when planning budget allocation."
        ),
        "exec": (
            "Performance metrics confirm the paid search channel is dormant rather than "
            "underperforming, since no spend has been deployed to evaluate. Leadership should decide "
            "whether to reactivate a controlled test campaign, particularly to capitalize on the "
            "newly strengthened organic rankings on the homepage and careers pages, or formally "
            "reallocate the paid search budget elsewhere."
        ),
    },
    {
        "title": "LinkedIn Organic Growth",
        "strategic": (
            "Followers grew from 21,872 to 22,830 over 30 days, a net addition of 265 (604 gained "
            "against 339 lost), while impressions reached 123,037 and clicks reached 13,143. Blended "
            "engagement rate across the period stands at 12.07 percent, well above typical organic "
            "social benchmarks, driven by consistent daily posting activity rather than a single "
            "viral event."
        ),
        "business": (
            "Sustained audience growth on LinkedIn expands brand reach and top-of-funnel awareness at "
            "zero incremental media cost, complementing the paid search gap identified above. "
            "Consistent engagement quality suggests the content strategy is resonating with the "
            "target audience rather than relying on reach alone."
        ),
        "exec": (
            "Strong indicators establish LinkedIn organic as the most cost-efficient active growth "
            "channel today. Leadership should protect current content cadence and evaluate whether "
            "incremental investment in LinkedIn paid promotion could compound this organic momentum, "
            "given Google Ads remains inactive."
        ),
    },
    {
        "title": "LinkedIn Organic Data Anomaly (July 1)",
        "strategic": (
            "July 1 recorded 3,772 clicks and an engagement rate of 176 percent, both far outside the "
            "normal daily range of 50 to 900 clicks and 5 to 47 percent engagement rate seen on every "
            "other day in the period. An engagement rate above 100 percent is mathematically "
            "inconsistent with standard impression-to-engagement calculation and indicates a data "
            "capture or attribution error for that single day."
        ),
        "business": (
            "If left uncorrected, this single-day anomaly will overstate 30-day click and engagement "
            "averages for LinkedIn organic, inflating the channel's reported efficiency relative to "
            "its true baseline performance."
        ),
        "exec": (
            "Early signals hint at a platform-side reporting defect isolated to July 1 rather than a "
            "genuine content outperformance event. Leadership should request source-level validation "
            "from the LinkedIn data connector before citing 30-day LinkedIn engagement averages in "
            "board reporting."
        ),
    },
]


def header_footer(canvas_obj, doc):
    canvas_obj.saveState()
    # Header line
    canvas_obj.setStrokeColor(NAVY)
    canvas_obj.setLineWidth(1.2)
    canvas_obj.line(0.75 * inch, letter[1] - 0.65 * inch, letter[0] - 0.75 * inch, letter[1] - 0.65 * inch)
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.setFillColor(GREY)
    canvas_obj.drawString(0.75 * inch, letter[1] - 0.55 * inch, "York IE  |  Monthly Growth Assessment")
    canvas_obj.drawRightString(letter[0] - 0.75 * inch, letter[1] - 0.55 * inch, "Prepared for C-Suite Review")
    # Footer
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.drawString(0.75 * inch, 0.5 * inch, "York IE \u2014 Confidential")
    canvas_obj.drawRightString(letter[0] - 0.75 * inch, 0.5 * inch, f"Page {doc.page}")
    canvas_obj.restoreState()


def build_pdf():
    doc = SimpleDocTemplate(
        OUTPUT_PATH, pagesize=letter,
        topMargin=1.0 * inch, bottomMargin=0.85 * inch,
        leftMargin=0.75 * inch, rightMargin=0.75 * inch,
        title="York IE Monthly Growth Assessment",
        author="York IE Growth Strategy",
    )

    story = []

    # ---- Cover / Title ----
    story.append(Paragraph("Monthly Growth Assessment", title_style))
    story.append(Paragraph("york.ie \u2014 Reporting Period: June 24, 2026 to July 23, 2026", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=1, color=NAVY, spaceAfter=14))

    # ---- Executive Summary ----
    story.append(Paragraph("Executive Summary", h1_style))
    story.append(Paragraph(EXEC_NARRATIVE, body_style))

    story.append(Paragraph("Outlook", h2_style))
    story.append(Paragraph(OUTLOOK, body_style))

    story.append(Paragraph("Wins", h2_style))
    story.append(ListFlowable(
        [ListItem(Paragraph(w, bullet_style), bulletColor=GREEN) for w in WINS],
        bulletType="bullet", start="circle", leftIndent=10
    ))

    story.append(Paragraph("Risks", h2_style))
    story.append(ListFlowable(
        [ListItem(Paragraph(r, bullet_style), bulletColor=RED) for r in RISKS],
        bulletType="bullet", start="circle", leftIndent=10
    ))

    story.append(Paragraph("Priorities for Next 30 Days", h2_style))
    story.append(ListFlowable(
        [ListItem(Paragraph(p, bullet_style), bulletColor=ACCENT) for p in PRIORITIES],
        bulletType="bullet", start="circle", leftIndent=10
    ))

    story.append(PageBreak())

    # ---- Channel Performance ----
    story.append(Paragraph("Channel Performance", h1_style))
    for ch in CHANNELS:
        badge_color = status_badge(ch["status"])
        header_table = Table(
            [[Paragraph(f"<b>{ch['name']}</b>", body_style),
              Paragraph(ch["status"], label_style)]],
            colWidths=[4.6 * inch, 1.7 * inch]
        )
        header_table.setStyle(TableStyle([
            ("BACKGROUND", (1, 0), (1, 0), badge_color),
            ("BACKGROUND", (0, 0), (0, 0), LIGHT_BG),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (1, 0), (1, 0), "CENTER"),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING", (0, 0), (0, 0), 8),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#D5D8DC")),
        ]))
        block = [header_table]
        if ch["summary"]:
            block.append(Spacer(1, 4))
            block.append(Paragraph(ch["summary"], body_style))
        else:
            block.append(Spacer(1, 4))
            block.append(Paragraph(
                "No data connection is configured for this channel during the reporting period. "
                "Reactivate the integration to include LinkedIn Paid performance in future assessments.",
                ParagraphStyle("Unavail", parent=body_style, textColor=GREY, fontName="Helvetica-Oblique")
            ))
        block.append(Spacer(1, 10))
        story.append(KeepTogether(block))

    story.append(PageBreak())

    # ---- Detailed Findings ----
    story.append(Paragraph("Detailed Findings", h1_style))
    for f in FINDINGS:
        block = [
            Paragraph(f["title"], finding_head_style),
            Paragraph("Strategic Explanation", finding_sub_style),
            Paragraph(f["strategic"], body_style),
            Paragraph("Business Context", finding_sub_style),
            Paragraph(f["business"], body_style),
            Paragraph("Executive Interpretation", finding_sub_style),
            Paragraph(f["exec"], body_style),
            Spacer(1, 8),
            HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#D5D8DC"), spaceAfter=6),
        ]
        story.append(KeepTogether(block))

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    print(f"PDF written to {OUTPUT_PATH}")


if __name__ == "__main__":
    build_pdf()
