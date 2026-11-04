#!/usr/bin/env python3
import json
import math
import os
import sys
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, Frame, ListFlowable, ListItem, PageTemplate, Paragraph, Spacer, Table, TableStyle

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT_MARGIN = 22 * mm
RIGHT_MARGIN = 22 * mm
TOP_MARGIN = 22 * mm
BOTTOM_MARGIN = 18 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN


def hex_color(value, fallback):
    try:
        return colors.HexColor(value)
    except Exception:
        return colors.HexColor(fallback)


def load_payload(input_path):
    with open(input_path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def build_styles(meta):
    styles = getSampleStyleSheet()
    navy = hex_color(meta.get('accentNavy', '#1F355E'), '#1F355E')
    blue = hex_color(meta.get('accentBlue', '#2E73B8'), '#2E73B8')
    gold = hex_color(meta.get('accentGold', '#C88A1A'), '#C88A1A')

    return {
        'navy': navy,
        'blue': blue,
        'gold': gold,
        'body': ParagraphStyle(
            'Body',
            parent=styles['Normal'],
            fontName='Helvetica',
            fontSize=10.9,
            leading=14.2,
            textColor=colors.black,
            spaceAfter=7,
        ),
        'section': ParagraphStyle(
            'Section',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=18,
            leading=22,
            textColor=navy,
            spaceAfter=3,
            spaceBefore=12,
        ),
        'subsection': ParagraphStyle(
            'Subsection',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=13.8,
            leading=17,
            textColor=blue,
            spaceAfter=6,
            spaceBefore=8,
        ),
        'title': ParagraphStyle(
            'Title',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=30,
            leading=35,
            alignment=TA_CENTER,
            textColor=navy,
            spaceAfter=8,
        ),
        'subtitle': ParagraphStyle(
            'Subtitle',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=17,
            leading=22,
            alignment=TA_CENTER,
            textColor=blue,
            spaceAfter=3,
        ),
        'firm': ParagraphStyle(
            'Firm',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=26,
            leading=30,
            alignment=TA_CENTER,
            textColor=navy,
            spaceAfter=2,
        ),
        'tagline': ParagraphStyle(
            'Tagline',
            parent=styles['Normal'],
            fontName='Helvetica-Oblique',
            fontSize=12.5,
            leading=15,
            alignment=TA_CENTER,
            textColor=colors.grey,
            spaceAfter=6,
        ),
        'meta': ParagraphStyle(
            'Meta',
            parent=styles['Normal'],
            fontName='Helvetica',
            fontSize=10.5,
            leading=12.5,
            textColor=navy,
        ),
        'contact': ParagraphStyle(
            'Contact',
            parent=styles['Normal'],
            fontName='Helvetica',
            fontSize=11,
            leading=14,
            textColor=colors.black,
            spaceAfter=4,
        ),
        'contact_compact': ParagraphStyle(
            'ContactCompact',
            parent=styles['Normal'],
            fontName='Helvetica',
            fontSize=10.4,
            leading=12.2,
            textColor=colors.black,
            spaceAfter=0,
        ),
        'contact_header': ParagraphStyle(
            'ContactHeader',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=16,
            leading=19,
            textColor=navy,
            spaceAfter=8,
        ),
        'table_header': ParagraphStyle(
            'TableHeader',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=9.2,
            leading=11,
            textColor=colors.white,
        ),
        'table_cell': ParagraphStyle(
            'TableCell',
            parent=styles['Normal'],
            fontName='Helvetica',
            fontSize=9.1,
            leading=11,
            textColor=colors.black,
        ),
        'table_cell_bold': ParagraphStyle(
            'TableCellBold',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=9.2,
            leading=11,
            textColor=colors.black,
        ),
        'meta_label': ParagraphStyle(
            'MetaLabel',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=10.4,
            leading=12,
            textColor=navy,
        ),
        'meta_value': ParagraphStyle(
            'MetaValue',
            parent=styles['Normal'],
            fontName='Helvetica',
            fontSize=10.4,
            leading=12,
            textColor=colors.black,
        ),
    }


def hline(story, styles):
    story.append(Table([['']], colWidths=[CONTENT_WIDTH], rowHeights=[1], style=TableStyle([
        ('LINEABOVE', (0, 0), (-1, -1), 0.8, styles['gold']),
    ])))
    story.append(Spacer(1, 6))


def meta_table(meta, styles):
    rows = [
        [Paragraph('Prepared For:', styles['meta_label']), Paragraph(meta.get('preparedFor', ''), styles['meta_value'])],
        [Paragraph('Prepared By:', styles['meta_label']), Paragraph(meta.get('preparedByCompany', meta.get('preparedBy', '')), styles['meta_value'])],
        [Paragraph('Date:', styles['meta_label']), Paragraph(meta.get('dateLabel', ''), styles['meta_value'])],
        [Paragraph('Classification:', styles['meta_label']), Paragraph(meta.get('classification', 'Confidential'), styles['meta_value'])],
    ]
    table = Table(rows, colWidths=[33 * mm, 44 * mm], hAlign='LEFT')
    table.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.8, colors.black),
        ('BACKGROUND', (0, 0), (0, -1), colors.whitesmoke),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return table


def data_table(table_data, widths, styles, font_size=10.4):
    header_row = [Paragraph(str(cell), styles['table_header']) for cell in table_data['headers']]
    body_rows = []
    for row in table_data['rows']:
      body_rows.append([
        Paragraph(str(cell), styles['table_cell_bold'] if index == 0 else styles['table_cell'])
        for index, cell in enumerate(row)
      ])

    rows = [header_row] + body_rows
    table = Table(rows, colWidths=widths, repeatRows=1, hAlign='LEFT')
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), styles['navy']),
        ('GRID', (0, 0), (-1, -1), 0.8, colors.black),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    return table


def bullet_list(items, body_style):
    flowables = []
    for item in items:
        text = f"<b>{item['title']}:</b> {item['detail']}"
        flowables.append(ListItem(Paragraph(text, body_style), leftIndent=12))
    return ListFlowable(flowables, bulletType='bullet', start='circle', leftIndent=14)


def numbered_list(items, body_style):
    flowables = []
    for item in items:
        flowables.append(ListItem(Paragraph(item, body_style), leftIndent=12))
    return ListFlowable(flowables, bulletType='1', leftIndent=18)


def section_header(text, styles):
    return [Paragraph(text, styles['section']), Table([['']], colWidths=[CONTENT_WIDTH], rowHeights=[1], style=TableStyle([
        ('LINEABOVE', (0, 0), (-1, -1), 0.8, styles['gold']),
    ])), Spacer(1, 8)]


def subsection_header(text, styles):
    return Paragraph(text, styles['subsection'])


def footer(canvas, doc, meta, styles):
    page_num = canvas.getPageNumber()
    canvas.saveState()
    canvas.setFont('Helvetica', 9)
    canvas.setFillColor(colors.grey)
    footer_text = f"{meta.get('classification', 'Confidential')}  -  Page {page_num}"
    canvas.drawCentredString(PAGE_WIDTH / 2.0, 10 * mm, footer_text)
    canvas.restoreState()


def build_story(payload):
    meta = payload['meta']
    document = payload['document']
    styles = build_styles(meta)
    story = []

    story.append(Paragraph(meta.get('firmName', 'Bab Al Ilm AI').upper(), styles['firm']))
    story.append(Paragraph(meta.get('firmTagline', ''), styles['tagline']))
    hline(story, styles)
    story.append(Spacer(1, 24))
    story.append(Paragraph('TECHNICAL PROPOSAL', styles['title']))
    story.append(Paragraph(document['solutionName'], styles['subtitle']))
    if document.get('solutionSubtitle'):
        story.append(Paragraph(document['solutionSubtitle'], styles['subtitle']))
    story.append(Spacer(1, 24))
    story.append(meta_table(meta, styles))
    story.append(Spacer(1, 10))
    story.append(Paragraph(f"<b>{meta.get('firmName', 'Bab Al Ilm AI')}</b>  |  {document['solutionName']}", styles['meta']))
    hline(story, styles)

    story.extend(section_header('1. Executive Summary', styles))
    for paragraph in document['executiveSummary']:
        story.append(Paragraph(paragraph, styles['body']))

    story.extend(section_header('2. The Challenge', styles))
    story.append(Paragraph(document['challengeIntro'], styles['body']))
    story.append(bullet_list(document['challengePoints'], styles['body']))
    story.append(Spacer(1, 6))

    story.extend(section_header('3. Proposed Solution', styles))
    story.append(subsection_header('3.1 Solution Overview', styles))
    for paragraph in document['solutionOverview']:
        story.append(Paragraph(paragraph, styles['body']))
    story.append(data_table(document['architectureTable'], [36 * mm, 58 * mm, 72 * mm], styles))
    story.append(Spacer(1, 10))
    story.append(subsection_header('3.2 Key Capabilities', styles))
    story.append(bullet_list(document['keyCapabilities'], styles['body']))
    story.append(Spacer(1, 10))
    story.append(subsection_header(f"3.3 {document['workflowTransformationTitle']}", styles))
    story.append(Paragraph(document['workflowTransformationIntro'], styles['body']))
    story.append(data_table(document['workflowTable'], [46 * mm, 60 * mm, 60 * mm], styles, 9.2))

    story.extend(section_header('4. Technical Approach', styles))
    story.append(subsection_header(f"4.1 {document['technicalApproachTitle']}", styles))
    story.append(data_table(document['integrationTable'], [40 * mm, 66 * mm, 60 * mm], styles, 9.2))
    story.append(Spacer(1, 10))
    story.append(subsection_header('4.2 Implementation Workflow', styles))
    story.append(numbered_list(document['implementationSteps'], styles['body']))
    story.append(Spacer(1, 10))
    story.append(subsection_header('4.3 Security Controls', styles))
    story.append(bullet_list(document['securityControls'], styles['body']))

    story.extend(section_header('5. Implementation Roadmap', styles))
    story.append(Paragraph(document['roadmapIntro'], styles['body']))
    story.append(data_table(document['roadmapTable'], [19 * mm, 35 * mm, 83 * mm, 29 * mm], styles, 8.9))
    story.append(Spacer(1, 8))
    story.append(Paragraph(document['roadmapNote'], styles['body']))

    story.extend(section_header('6. Investment Overview', styles))
    story.append(Paragraph(document['investmentIntro'], styles['body']))
    story.append(data_table(document['investmentTable'], [65 * mm, 48 * mm, 53 * mm], styles, 9.1))
    story.append(Spacer(1, 8))
    story.append(Paragraph(document['investmentNote'], styles['body']))

    story.extend(section_header(f"7. Why {meta.get('firmName', 'Bab Al Ilm AI')}", styles))
    story.append(bullet_list(document['whyUs'], styles['body']))
    story.append(Spacer(1, 8))

    story.extend(section_header('8. Next Steps', styles))
    story.append(Paragraph(document['nextStepsIntro'], styles['body']))
    story.append(numbered_list(document['nextSteps'], styles['body']))
    story.append(Spacer(1, 12))
    contact_lines = [line for line in [meta.get('contactName', ''), meta.get('contactRole', ''), meta.get('contactCompany', ''), meta.get('contactEmail', ''), meta.get('firmWebsite', '')] if line]
    story.append(Paragraph('Contact', styles['contact_header']))
    story.append(Paragraph('<br/>'.join(contact_lines), styles['contact_compact']))

    return story, styles


def render(input_path, output_path):
    payload = load_payload(input_path)
    story, styles = build_story(payload)
    meta = payload['meta']

    doc = BaseDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title=meta.get('fileTitle', 'proposal.pdf'),
        author=meta.get('firmName', 'Bab Al Ilm AI'),
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='main-frame')
    template = PageTemplate(id='main-template', frames=[frame], onPage=lambda canvas, doc_ref: footer(canvas, doc_ref, meta, styles))
    doc.addPageTemplates([template])
    doc.build(story)


def main():
    if len(sys.argv) != 3:
        print('Usage: render_proposal_pdf.py <input_json> <output_pdf>', file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    render(input_path, output_path)


if __name__ == '__main__':
    main()
