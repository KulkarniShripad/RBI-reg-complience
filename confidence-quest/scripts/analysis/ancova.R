# Planned analysis: post confidence by arm, adjusting for pre confidence (ANCOVA).
# Usage: Rscript scripts/analysis/ancova.R data/exports/<timestamp>/participants.csv

args <- commandArgs(trailingOnly = TRUE)
df <- read.csv(args[1], stringsAsFactors = FALSE)
df <- subset(df, status == "completed" & !is.na(pre_conf_mean) & !is.na(post_conf_mean))

print(aggregate(cbind(pre_conf_mean, post_conf_mean, conf_change, score_raw) ~ arm, data = df, FUN = mean))

# H1: the experimental arm gains more confidence -> positive arm_code coefficient.
model <- lm(post_conf_mean ~ arm_code + pre_conf_mean, data = df)
print(summary(model))
print(anova(model))

# Homogeneity of regression slopes: the interaction should be non-significant.
print(anova(lm(post_conf_mean ~ arm_code * pre_conf_mean, data = df)))
