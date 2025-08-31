from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, Dict, List, Literal
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_JSON = os.path.join(HERE, "state_tax.json")
BUDGET_JSON = os.path.join(HERE, "budget_data.json")

app = FastAPI(title="Budget & Mortgage API", version="0.4.2-survival-dual")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TaxIn(BaseModel):
    annual_income: float = Field(..., ge=0)
    filing_status: str = Field(..., pattern="^(single|married_joint|head_of_household)$")
    state_rate: Optional[float] = Field(0, ge=0)
    state_code: Optional[str] = None

class BudgetIn(BaseModel):
    monthly_takehome: float = Field(..., ge=0)  # not used to scale in survival model
    adults: int = Field(1, ge=1, le=10)
    kids: int = Field(0, ge=0, le=10)

class BorrowIn(BaseModel):
    annual_income: float = Field(..., ge=0)
    other_monthly_debt: float = Field(0, ge=0)
    rate_annual: float = Field(..., ge=0)
    term_years: int = Field(..., ge=1)
    taxes_insurance_monthly: float = Field(0, ge=0)
    front_end_ratio: float = Field(..., ge=0, le=1)
    back_end_ratio: float = Field(..., ge=0, le=1)
    use_takehome: bool = False
    monthly_takehome: Optional[float] = None
    surplus_limit: Optional[float] = Field(None, ge=0)

with open(STATE_JSON,"r") as f:
    STATE_TAX = json.load(f)
with open(BUDGET_JSON,"r") as f:
    BUDGET = json.load(f)

def compute_progressive_tax(taxable_income: float, brackets: List[List[float]]) -> float:
    taxable = max(0.0, float(taxable_income))
    tax = 0.0
    for i,(lower,rate) in enumerate(brackets):
        upper = brackets[i+1][0] if i+1 < len(brackets) else None
        if upper is None:
            slice_amt = max(0.0, taxable - lower)
        else:
            slice_amt = max(0.0, min(taxable, upper) - lower)
        if slice_amt > 0: tax += slice_amt * rate
        if upper is not None and taxable <= upper: break
    return tax

def compute_federal_tax(income: float, filing_status: str) -> float:
    std = STATE_TAX.get("standard_deduction", {}).get(filing_status, 0.0)
    taxable = max(0.0, income - std)
    brackets = STATE_TAX["federal"][filing_status]
    return compute_progressive_tax(taxable, brackets)

def compute_state_tax(income: float, filing_status: str, state_code: Optional[str], manual_rate: float):
    if state_code is None:
        tax = income * (manual_rate or 0.0)
        return {"mode":"flat_manual","rate":manual_rate or 0.0,"tax":tax}
    if state_code in STATE_TAX.get("no_tax", []):
        return {"mode":"no_tax","rate":0.0,"tax":0.0}
    flat = STATE_TAX.get("flat_rates", {}).get(state_code)
    if isinstance(flat,(int,float)):
        return {"mode":"flat","rate":float(flat),"tax":income*float(flat)}
    prog = STATE_TAX.get("progressive", {}).get(state_code)
    if prog:
        brackets = prog.get(filing_status)
        if brackets:
            std = STATE_TAX.get("standard_deduction", {}).get(filing_status, 0.0)
            taxable = max(0.0, income - std)
            tax = compute_progressive_tax(taxable, brackets)
            return {"mode":"progressive","rate":None,"tax":tax}
    return {"mode":"unknown","rate":0.0,"tax":0.0}

@app.get("/state_tax")
def get_state_tax():
    return STATE_TAX

@app.post("/api/calc/tax")
def calc_tax(payload: TaxIn):
    fed = compute_federal_tax(payload.annual_income, payload.filing_status)
    st = compute_state_tax(payload.annual_income, payload.filing_status, payload.state_code, payload.state_rate or 0.0)
    net_annual = max(0.0, payload.annual_income - fed - st["tax"])
    return {"federal":{"federal_tax": round(fed,2)},
            "state_tax": round(st["tax"],2),
            "state_details":{"mode": st["mode"], "rate": st["rate"], "tax": round(st["tax"],2)},
            "net_annual": round(net_annual,2),
            "monthly_takehome": round(net_annual/12.0,2)}

@app.post("/api/calc/budget")
def calc_budget(payload: BudgetIn):
    # survival-only: ignore income for scaling; base per adult/kid with diminishing equivalence
    adults = max(1, int(payload.adults))
    kids   = max(0, int(payload.kids))
    eq_adult_extra = BUDGET.get("equivalence",{}).get("adult_extra",0.5)
    eq_kid        = BUDGET.get("equivalence",{}).get("kid",0.3)
    equivalence = 1.0 + eq_adult_extra*(adults-1) + eq_kid*kids
    exponents = BUDGET.get("exponents",{})
    cats = BUDGET.get("categories",{})
    alloc = {}
    for cat, params in cats.items():
        base_adult = float(params.get("base_adult",0.0))
        base_kid   = float(params.get("base_kid",0.0))
        exp        = float(exponents.get(cat,0.7))
        base_sum = base_adult*adults + base_kid*kids
        scaled = base_sum * (equivalence ** exp)
        alloc[cat] = round(scaled, 2)
    return {"equivalence": round(equivalence,3), "allocations": alloc, "exponents": exponents}

def payment_to_principal(monthly_payment: float, annual_rate: float, years: int) -> float:
    r_m = annual_rate / 12.0
    n = years * 12
    if r_m <= 0:
        return monthly_payment * n
    denom = r_m / (1 - (1 + r_m) ** (-n))
    return (monthly_payment / denom) if denom != 0 else 0.0

@app.post("/api/calc/borrow")
def calc_borrow(payload: BorrowIn):
    # DTI baseline income
    if payload.use_takehome and payload.monthly_takehome is not None:
        base_monthly = max(0.0, float(payload.monthly_takehome)); basis="net"
    else:
        base_monthly = payload.annual_income / 12.0; basis="gross"

    # DTI caps (monthly P&I capacity ignoring surplus)
    cap_front = max(0.0, base_monthly*payload.front_end_ratio - payload.taxes_insurance_monthly)
    cap_back  = max(0.0, base_monthly*payload.back_end_ratio - payload.other_monthly_debt - payload.taxes_insurance_monthly)
    dti_cap = max(0.0, min(cap_front, cap_back))

    # Surplus cap (monthly P&I from budget surplus)
    surplus_cap = max(0.0, float(payload.surplus_limit)) if payload.surplus_limit is not None else None

    # Convert both to principals
    principal_dti     = payment_to_principal(dti_cap, payload.rate_annual, payload.term_years)
    principal_surplus = payment_to_principal(surplus_cap or 0.0, payload.rate_annual, payload.term_years)

    # Choose used (conservative)
    if surplus_cap is None:
        monthly_used = dti_cap
        reason = "dti"
    else:
        if surplus_cap < dti_cap:
            monthly_used = surplus_cap; reason = "surplus"
        else:
            monthly_used = dti_cap;     reason = "dti"

    used_principal = payment_to_principal(monthly_used, payload.rate_annual, payload.term_years)

    return {
        "monthly_PI_dti": round(dti_cap, 2),
        "max_principal_dti": round(principal_dti, 2),
        "monthly_PI_surplus": round((surplus_cap or 0.0), 2),
        "max_principal_surplus": round(principal_surplus, 2),
        "monthly_PI_used": round(monthly_used, 2),
        "max_principal_used": round(used_principal, 2),
        "assumptions": {"rate_annual": payload.rate_annual, "term_years": payload.term_years, "income_basis": basis},
        "limit_reason": reason
    }
