from regcomp.text import amounts_in, normalize, split_sentences


def test_amounts():
    assert amounts_in("does not exceed Rupees One Lakh")[0][0] == 100000
    assert amounts_in("does not exceed ₹10,000 in a month")[0][0] == 10000
    assert amounts_in("a net worth of Rs. 5 crore")[0][0] == 5e7
    assert amounts_in("₹50,000")[0][0] == 50000


def test_normalize_dashes_and_quotes():
    assert normalize("Commercial Banks – KYC “Directions”") == 'Commercial Banks - KYC "Directions"'


def test_sentences_keep_abbreviations():
    s = split_sentences("The bank shall pay Rs. 500 per day. It shall also report to the RBI.")
    assert len(s) == 2 and s[0].startswith("The bank shall pay Rs. 500")
