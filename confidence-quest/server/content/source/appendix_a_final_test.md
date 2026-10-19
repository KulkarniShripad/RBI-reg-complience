# Appendix A: Final test (paste-ready)

Verbatim source for `questions.json` and `answer_key.json`. The content test
(`tests/unit/content.test.js`) parses this file and fails if the JSON content
differs from it in any way. Do not edit, reorder or add questions.

## Section 1: Sliding Window

**Q1 (Easy).** Max sum of a subarray of size k:

```python
s = sum(a[:k]); best = s
for i in range(k, len(a)):
    s += a[i] - ______
    best = max(best, s)
```

A) a[k]
B) a[i-k+1]
C) a[i-k-1]
D) a[i-k]

**Q2 (Medium).** How many subarrays of [1, 2, 1, 2, 3] have exactly 2 distinct integers?

A) 5
B) 6
C) 7
D) 8

**Q3 (Hard).** You need the shortest subarray with sum ≥ K in an array that can contain negatives, in O(n). Which approach works?

A) Prefix sums + monotonic increasing deque of indices
B) Expand right, shrink left while sum ≥ K (standard two-pointer window)
C) Prefix sums + hash map looking up prefix - K
D) Sort the prefix sums and binary search for each one

## Section 2: Two Pointers

**Q4 (Easy).** Two-sum on a sorted array:

```python
l, r = 0, len(a) - 1
while l < r:
    s = a[l] + a[r]
    if s == t: return [l, r]
    elif s < t: ______
    else: ______
```

A) r -= 1 / l += 1
B) l += 1 / r -= 1
C) l += 1 / l += 1
D) r -= 1 / r -= 1

**Q5 (Medium).** 3Sum on sorted a = [-2, 0, 0, 2, 2]. The outer loop skips duplicate i, but after a match the code does only l += 1; r -= 1 (no duplicate skipping). What is returned?

A) []
B) [[-2, 0, 2]]
C) IndexError
D) [[-2, 0, 2], [-2, 0, 2]]

**Q6 (Hard).** Dutch National Flag, but the author wrote mid += 1 in the last branch:

```python
a = [1, 2, 0]
lo = mid = 0; hi = len(a) - 1
while mid <= hi:
    if a[mid] == 0:
        a[lo], a[mid] = a[mid], a[lo]; lo += 1; mid += 1
    elif a[mid] == 1:
        mid += 1
    else:
        a[mid], a[hi] = a[hi], a[mid]; hi -= 1; mid += 1   # bug
print(a)
```

A) [1, 0, 2]
B) [0, 1, 2]
C) [1, 2, 0]
D) [0, 2, 1]

## Section 3: Arrays

**Q7 (Easy).** Kadane’s algorithm:

```python
cur = best = a[0]
for x in a[1:]:
    cur = max(x, ______)
    best = max(best, cur)
```

A) x
B) cur + x
C) cur
D) best + x

**Q8 (Medium).** In-place rotation of [1,2,3,4,5,6,7] right by k = 3 should give [5,6,7,1,2,3,4]. Which reversal sequence does it? (rev(i,j) reverses indices i..j inclusive)

A) rev(0,2), rev(3,6), rev(0,6)
B) rev(0,3), rev(4,6) only
C) rev(0,6), rev(0,2), rev(3,6)
D) rev(0,6), rev(0,3), rev(4,6)

**Q9 (Hard).**

```python
cand, cnt = None, 0
for x in [3, 1, 3, 2, 2]:
    if cnt == 0: cand = x
    cnt += 1 if x == cand else -1
print(cand)
```

A) None
B) 1
C) 3
D) 2

## Answer key

| Q | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Answer | D | C | A | B | D | A | B | C | D |
