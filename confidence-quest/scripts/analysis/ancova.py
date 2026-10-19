"""Planned analysis: post confidence by arm, adjusting for pre confidence (ANCOVA).

Usage:  pip install pandas statsmodels
        python3 scripts/analysis/ancova.py data/exports/<timestamp>/participants.csv
"""
import sys

import pandas as pd
import statsmodels.formula.api as smf

df = pd.read_csv(sys.argv[1])
df = df[df["status"] == "completed"].dropna(subset=["pre_conf_mean", "post_conf_mean", "arm_code"])

print(df.groupby("arm")[["pre_conf_mean", "post_conf_mean", "conf_change", "score_raw"]].agg(["count", "mean", "std"]).round(3))

# H1: the experimental arm gains more confidence -> positive arm_code coefficient.
model = smf.ols("post_conf_mean ~ arm_code + pre_conf_mean", data=df).fit()
print(model.summary())

# Homogeneity of regression slopes (ANCOVA assumption): the interaction should be non-significant.
check = smf.ols("post_conf_mean ~ arm_code * pre_conf_mean", data=df).fit()
print(f"\narm x pre interaction p = {check.pvalues['arm_code:pre_conf_mean']:.3f}")
