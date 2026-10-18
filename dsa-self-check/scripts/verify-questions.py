# Compiles and runs every code question in Python, C++ and Java and checks the answer keys.
#
#   npm run verify-questions        (= python3 scripts/verify-questions.py src/content/questions.json)
#
# Needs python3, g++ (C++17) and javac/java on the PATH.
# When you add or change a question with code, add its test cases to TESTS below:
#   (python call, C++ call, Java call, expected output)   expected = None for "trace" questions,
# whose expected output is the correct option's text.
# trace: the program's output must equal the correct option's text (and no other option).
# complete: every option is put into the blank; the correct one must give the expected
# output on every test, each wrong one must fail at least one test (wrong output, crash or timeout).
import json, os, subprocess, sys, tempfile, shutil

QFILE = sys.argv[1]
doc = json.load(open(QFILE, encoding="utf-8"))
BLANK = doc["blank"]
qs = {q["id"]: q for q in doc["questions"]}

def txt(opt, lang):
    t = opt["text"]
    return t if isinstance(t, str) else t[lang]

# tests: list of (python call, c++ call, java call, expected)
def arr_py(a): return "[" + ", ".join(map(str, a)) + "]"
def arr_c(a): return "{" + ", ".join(map(str, a)) + "}"
def arr_j(a): return "new int[]{" + ", ".join(map(str, a)) + "}"

TESTS = {
  "S1-01": [(f"two_sum({arr_py(a)}, {t})", f"two_sum({arr_c(a)}, {t})", f"twoSum({arr_j(a)}, {t})", e) for a, t, e in [
      ([2, 7, 11, 15], 9, "[0, 1]"), ([3, 2, 4], 6, "[1, 2]"), ([1, 4, 3], 7, "[1, 2]"), ([5, 1, 5], 10, "[0, 2]"), ([1, 2], 10, "[]")]],
  "S1-03": [("f([2, 1, 5, 1, 3, 2], 3)", "f({2, 1, 5, 1, 3, 2}, 3)", "f(new int[]{2, 1, 5, 1, 3, 2}, 3)", None)],
  "S1-04": [(f"dedupe({arr_py(a)})", f"dd({arr_c(a)})", f"dedupe({arr_j(a)})", e) for a, e in [
      ([1, 1, 2], "2"), ([1, 2, 2], "2"), ([0, 0, 1, 1, 1, 2, 2, 3, 3, 4], "5"), ([1, 2, 3], "3"), ([4, 4, 4], "1")]],
  "S1-05": [("f(6)", "f(6)", "f(6)", None)],
  "S2-01": [(f"near_dup({arr_py(a)}, {k})", f"near_dup({arr_c(a)}, {k})", f"nearDup({arr_j(a)}, {k})", e) for a, k, e in [
      ([1, 2, 1], 2, "true"), ([1, 2, 3, 1], 1, "false"), ([7, 8, 9, 1, 1], 1, "true"), ([1, 2, 1], 1, "false"), ([1, 0, 1, 1], 1, "true")]],
  "S2-03": [("f([1, 2, 3, 4], 6)", "f({1, 2, 3, 4}, 6)", "f(new int[]{1, 2, 3, 4}, 6)", None)],
  "S2-04": [(f"shortest({arr_py(a)}, {t})", f"shortest({arr_c(a)}, {t})", f"shortest({arr_j(a)}, {t})", e) for a, t, e in [
      ([2, 3, 1, 2, 4, 3], 7, "2"), ([1, 4, 4], 4, "1"), ([1, 1, 1, 1], 10, "0"), ([2, 3], 5, "2"), ([5], 3, "1")]],
  "S2-05": [("f([2, 7, 9, 3, 1])", "f({2, 7, 9, 3, 1})", "f(new int[]{2, 7, 9, 3, 1})", None)],
}

PY_PRE = "def show(v):\n    if isinstance(v, bool): return 'true' if v else 'false'\n    if isinstance(v, list): return '[' + ', '.join(map(str, v)) + ']'\n    return str(v)\n"
CPP_PRE = """#include <bits/stdc++.h>
using namespace std;
string show(int v) { return to_string(v); }
string show(bool v) { return v ? "true" : "false"; }
string show(vector<int> v) { string s = "["; for (size_t i = 0; i < v.size(); i++) { if (i) s += ", "; s += to_string(v[i]); } return s + "]"; }
"""
JAVA_PRE = "import java.util.*;\npublic class Main {\n" \
  "static String show(int v) { return Integer.toString(v); }\n" \
  "static String show(boolean v) { return v ? \"true\" : \"false\"; }\n" \
  "static String show(int[] v) { StringBuilder s = new StringBuilder(\"[\"); for (int i = 0; i < v.length; i++) { if (i > 0) s.append(\", \"); s.append(v[i]); } return s.append(\"]\").toString(); }\n"

work = tempfile.mkdtemp()

def run(cmd, cwd, timeout=10):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return -9, "", "TIMEOUT"

def run_lang(lang, code, tests):
    d = tempfile.mkdtemp(dir=work)
    if lang == "python":
        src = PY_PRE + code + "\n" + "".join(f"try:\n    print(show({t[0]}))\nexcept Exception as e:\n    print('ERR')\n" for t in tests)
        open(os.path.join(d, "m.py"), "w").write(src)
        rc, out, err = run([sys.executable, "-I", "m.py"], d, 5)
    elif lang == "cpp":
        extra = "int dd(vector<int> v) { return dedupe(v); }\n" if "dedupe(" in code else ""
        src = CPP_PRE + code + "\n" + extra + "int main() {\n" + "".join(f"    cout << show({t[1]}) << endl;\n" for t in tests) + "}\n"
        open(os.path.join(d, "m.cpp"), "w").write(src)
        rc, out, err = run(["g++", "-std=c++17", "-O0", "-fsanitize=address,undefined", "-o", "m", "m.cpp"], d, 120)
        if rc != 0:
            return None, "COMPILE: " + err[:800]
        rc, out, err = run(["./m"], d, 5)
    else:
        src = JAVA_PRE + code + "\npublic static void main(String[] args) {\n" + "".join(f"    System.out.println(show({t[2]}));\n" for t in tests) + "}\n}\n"
        open(os.path.join(d, "Main.java"), "w").write(src)
        rc, out, err = run(["javac", "Main.java"], d, 120)
        if rc != 0:
            return None, "COMPILE: " + err[:800]
        rc, out, err = run(["java", "-cp", ".", "Main"], d, 10)
    lines = out.strip().splitlines()
    if rc != 0:
        lines += ["CRASH"] * (len(tests) - len(lines))
    return lines, err

problems, checks = [], 0
for qid, tests in TESTS.items():
    q = qs[qid]
    correct = next(o for o in q["options"] if o["id"] == q["correct"])
    for lang in ["python", "cpp", "java"]:
        code = q["code"][lang]
        if q["type"] == "trace":
            assert BLANK not in code
            lines, err = run_lang(lang, code, tests)
            if lines is None:
                problems.append(f"{qid} {lang}: {err}"); continue
            got = lines[0] if lines else "?"
            checks += 1
            if got != txt(correct, lang):
                problems.append(f"{qid} {lang}: output {got} != correct option {txt(correct, lang)}")
            others = [txt(o, lang) for o in q["options"] if o["id"] != q["correct"]]
            if got in others:
                problems.append(f"{qid} {lang}: output {got} also matches a wrong option")
            print(f"{qid} {lang:6} trace -> {got}  (key {txt(correct, lang)})")
        else:
            assert code.count(BLANK) == 1, (qid, lang)
            expected = [t[3] for t in tests]
            for o in q["options"]:
                filled = code.replace(BLANK, txt(o, lang))
                lines, err = run_lang(lang, filled, tests)
                checks += 1
                if lines is None:
                    if o["id"] == q["correct"]:
                        problems.append(f"{qid} {lang} option {o['id']} (correct) does not compile: {err}")
                    print(f"{qid} {lang:6} option {o['id']}: does not compile")
                    continue
                ok = lines == expected
                tag = "CORRECT" if o["id"] == q["correct"] else "wrong  "
                print(f"{qid} {lang:6} option {o['id']} {tag} passes all tests: {ok}   {lines}")
                if o["id"] == q["correct"] and not ok:
                    problems.append(f"{qid} {lang}: correct option fails: {lines} vs {expected}")
                if o["id"] != q["correct"] and ok:
                    problems.append(f"{qid} {lang}: wrong option {o['id']} passes every test")

shutil.rmtree(work, ignore_errors=True)
print(f"\n{checks} checks")
print("PROBLEMS:\n" + "\n".join(problems) if problems else "ALL ANSWER KEYS VERIFIED")
