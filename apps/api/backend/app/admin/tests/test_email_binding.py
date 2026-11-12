"""#303: mail verification belongs to both the signed-in user and destination."""

import pytest

from backend.plugin.email.api.v1 import email as email_api


@pytest.fixture
def mail(client, token_headers, temp_user, monkeypatch):
    delivered = []

    async def send(_db, recipients, _subject, content, _template):  # ruff: ignore[unused-async]
        delivered.append((recipients, content['code']))

    monkeypatch.setattr(email_api, 'send_email', send)
    login = client.post('/auth/login/swagger', params={'username': 'pytest_tmp_writes', 'password': 'Tmp@123456'})
    assert login.status_code == 200, login.text
    headers = {'Authorization': f'Bearer {login.json()["access_token"]}'}
    return headers, delivered


def test_code_cannot_bind_another_destination(client, mail):
    headers, delivered = mail
    res = client.post('/emails/captcha', headers=headers, json={'recipients': 'owner@example.com'})
    assert res.status_code == 200, res.text
    code = delivered[-1][1]
    wrong = client.put('/sys/users/me/email', headers=headers, json={'email': 'victim@example.com', 'captcha': code})
    assert wrong.status_code == 400, wrong.text
    right = client.put('/sys/users/me/email', headers=headers, json={'email': 'owner@example.com', 'captcha': code})
    assert right.status_code == 200 and right.json()['code'] == 200, right.text
    replay = client.put('/sys/users/me/email', headers=headers, json={'email': 'owner@example.com', 'captcha': code})
    assert replay.status_code == 400, replay.text


def test_code_cannot_cross_users_on_same_ip(client, mail, token_headers):
    headers, delivered = mail
    res = client.post('/emails/captcha', headers=token_headers, json={'recipients': 'owner@example.com'})
    assert res.status_code == 200, res.text
    code = delivered[-1][1]
    wrong = client.put('/sys/users/me/email', headers=headers, json={'email': 'owner@example.com', 'captcha': code})
    assert wrong.status_code == 400, wrong.text


def test_guess_limit_consumes_code(client, mail):
    headers, delivered = mail
    res = client.post('/emails/captcha', headers=headers, json={'recipients': 'owner@example.com'})
    assert res.status_code == 200, res.text
    code = delivered[-1][1]
    guess = '000000' if code != '000000' else '111111'
    for _ in range(5):
        wrong = client.put(
            '/sys/users/me/email', headers=headers, json={'email': 'owner@example.com', 'captcha': guess}
        )
        assert wrong.status_code in (400, 422), wrong.text
    used = client.put('/sys/users/me/email', headers=headers, json={'email': 'owner@example.com', 'captcha': code})
    assert used.status_code == 400, used.text


@pytest.mark.parametrize('recipient', [['owner@example.com', 'victim@example.com'], '', 'invalid'])
def test_only_one_valid_destination(client, mail, recipient):
    headers, delivered = mail
    res = client.post('/emails/captcha', headers=headers, json={'recipients': recipient})
    assert res.status_code == 422, res.text
    assert not delivered


def test_failed_resend_keeps_last_delivered_code(client, mail, monkeypatch):
    from backend.common.exception import errors

    headers, delivered = mail
    response = client.post('/emails/captcha', headers=headers, json={'recipients': 'owner@example.com'})
    assert response.status_code == 200, response.text
    code = delivered[-1][1]

    async def fail(*args, **kwargs):  # ruff: ignore[unused-async]
        raise errors.GatewayError(msg='SMTP unavailable')

    monkeypatch.setattr(email_api, 'send_email', fail)
    response = client.post('/emails/captcha', headers=headers, json={'recipients': 'owner@example.com'})
    assert response.status_code == 502, response.text
    bound = client.put('/sys/users/me/email', headers=headers, json={'email': 'owner@example.com', 'captcha': code})
    assert bound.status_code == 200 and bound.json()['code'] == 200, bound.text
