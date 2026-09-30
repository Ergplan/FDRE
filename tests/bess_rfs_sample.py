"""A realistic standalone-BESS RfS used to test fdre_bess_tender (generated, not a real tender)."""

PAGES = [
    """GUJARAT URJA VIKAS NIGAM LIMITED
Request for Selection (RfS) for Procurement of 500 MW / 1000 MWh Standalone Battery Energy Storage System
on Build-Own-Operate basis with Viability Gap Funding, connected at the 220 kV Chandrapura Sub-station
RfS No. GUVNL/BESS/2026/Ph-III dated 12.08.2026
Tender Search Code: GUVNL-BESS-III

DISCLAIMER
This RfS document is not an agreement.""",
    """1. INTRODUCTION
1.1 GUVNL invites bids for setting up 500 MW / 1000 MWh (2 hours) Battery Energy Storage System (BESS)
at the Chandrapura Sub-station in Gujarat. The BESS shall be capable of two (2) operational cycles per day,
with a maximum of 730 cycles per year.
1.2 The Battery Energy Storage Purchase Agreement (BESPA) shall be for a period of 12 (twelve) years from the
Commercial Operation Date.
1.3 The Scheduled Commercial Operation Date (SCOD) shall be 18 (eighteen) months from the date of signing of BESPA.""",
    """2. TECHNICAL REQUIREMENTS
2.1 Round Trip Efficiency: The monthly AC-to-AC Round Trip Efficiency of the BESS shall not be less than 85%
measured at the delivery point.
2.2 Availability: The BESSD shall ensure a monthly system availability of not less than 95%.
2.3 The BESSD shall maintain the contracted capacity and energy throughout the term of the BESPA; any
augmentation required due to degradation shall be carried out by the BESSD at its own cost.
2.4 Charging power for the BESS shall be provided by the Procurer free of cost at the delivery point.""",
    """3. TARIFF AND VGF
3.1 Bidders shall quote a fixed Annual Capacity Charge in Rs./MW/month, which shall remain fixed for the
term of the BESPA. The ceiling tariff is Rs 3.80 lakh/MW/month.
3.2 Viability Gap Funding (VGF) of Rs 18 lakh/MWh shall be provided under the MoP VGF scheme, released in
tranches linked to commissioning and operation.
3.3 In case of shortfall in availability below 95% in a month, the capacity charge shall be reduced
proportionately and a penalty at 1.5 times the proportionate capacity charge shall be levied.
3.4 In case the Round Trip Efficiency is below 85%, the BESSD shall compensate the Procurer for the excess
energy losses at the applicable charging tariff.""",
    """4. BID CAPACITY AND SECURITIES
4.1 Minimum bid capacity shall be 50 MW and maximum bid capacity shall be 250 MW per bidder.
4.2 Earnest Money Deposit (EMD) of Rs 4 lakh/MW shall be submitted with the bid.
4.3 Performance Bank Guarantee of Rs 10 lakh/MW shall be submitted before signing of BESPA.
5. BID TIMELINE
5.1 Last date of bid submission: 15.09.2026. Techno-commercial bid opening: 17.09.2026. e-Reverse Auction:
30.09.2026.""",
]


def make_pdf(path: str) -> str:
    import fitz  # pymupdf

    doc = fitz.open()
    for text in PAGES:
        page = doc.new_page()
        page.insert_textbox(fitz.Rect(50, 50, 545, 800), text, fontsize=10, fontname="helv")
    doc.save(path)
    return path
