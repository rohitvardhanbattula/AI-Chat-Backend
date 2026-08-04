'use strict';
const bcrypt = require('bcryptjs');
const { sendMail } = require('@sap-cloud-sdk/mail-client');
const {
    MAX_CHATS_PER_USER, MAX_FAILED_LOGINS, ACCOUNT_LOCK_DURATION,
    OTP_EXPIRY_MINUTES, BCRYPT_ROUNDS, ALLOWED_EMAIL_DOMAIN
} = require('../utils/constants');
const {
    signAccessToken, createRefreshToken, rotateRefreshToken,
    revokeRefreshToken, ACCESS_TOKEN_TTL
} = require('../auth/jwt');

// ── Helpers ───────────────────────────────────────────────────────────────────
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) &&
           email.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN);
}

function sanitiseUsername(raw) {
    return (raw || '').toString().trim().toLowerCase().slice(0, 255);
}

/** Constant-time string comparison — prevents timing oracle on OTP */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function buildAuthTokens(userId, username) {
    const accessToken               = await signAccessToken({ userId, username });
    const { tokenValue: refreshToken } = await createRefreshToken(userId);
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL };
}

// ── In-process rate limiter for forgotPassword ────────────────────────────────
// Prevents OTP email spam to registered users. One request per email per 60s.
// This complements the Express-level authLimiter (which caps by IP).
const _fpLastSent = new Map(); // email → timestamp
const FP_COOLDOWN_MS = 60_000; // 1 minute

function checkForgotPasswordRateLimit(username) {
    const now  = Date.now();
    const last = _fpLastSent.get(username) || 0;
    if (now - last < FP_COOLDOWN_MS) {
        const waitSecs = Math.ceil((FP_COOLDOWN_MS - (now - last)) / 1000);
        throw Object.assign(new Error(`Please wait ${waitSecs}s before requesting another reset code.`), { statusCode: 429 });
    }
    _fpLastSent.set(username, now);
}

// ── Service ───────────────────────────────────────────────────────────────────
class AuthService {

    // ── Chat limits ───────────────────────────────────────────────────────────
    static async checkChatLimits(req) {
        // Use the authenticated userId from the verified JWT, NOT the client-supplied value.
        // Trusting req.data.userId would let any user bypass limits by spoofing another user's ID.
        const userId = req.user?.userId || req.data.userId;
        if (!userId) return req.reject(400, 'userId is required.');

        const [{ count }] = await SELECT
            .from('sap.aigateway.ChatSessions')
            .columns('count(*) as count')
            .where({ userId });

        if (Number(count) >= MAX_CHATS_PER_USER) {
            return req.reject(403,
                `Maximum of ${MAX_CHATS_PER_USER} chats reached. Please delete an older chat.`);
        }
    }

    // ── Register ──────────────────────────────────────────────────────────────
    static async register(req) {
        const username = sanitiseUsername(req.data.username);
        const password = (req.data.password || '').toString();

        if (!isValidEmail(username)) {
            return req.reject(400, `Registration is restricted to ${ALLOWED_EMAIL_DOMAIN} emails.`);
        }
        if (password.length < 8 || password.length > 128) {
            return req.reject(400, 'Password must be 8–128 characters.');
        }

        const existing = await SELECT.one.from('sap.aigateway.Users').where({ username });
        if (existing?.isVerified) {
            return req.reject(400, 'User already exists. Please log in.');
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const otp          = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry    = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000).toISOString();

        if (existing && !existing.isVerified) {
            await UPDATE('sap.aigateway.Users')
                .set({ passwordHash, otp, otpExpiry, failedLogins: 0, lockedUntil: null })
                .where({ username });
        } else {
            await INSERT.into('sap.aigateway.Users')
                .entries({ username, passwordHash, otp, otpExpiry, isVerified: false, failedLogins: 0 });
        }

        try {
            await sendMail({ destinationName: 'sap_process_automation_mail' }, [{
                to:      username,
                subject: 'AnswerThink Enterprise AI Hub — Verify Your Email',
                text: [
                    `Hello,`,
                    ``,
                    `Your one-time verification code is: ${otp}`,
                    ``,
                    `This code is valid for ${OTP_EXPIRY_MINUTES} minutes.`,
                    `If you did not request this, please ignore this email.`,
                    ``,
                    `— AnswerThink Enterprise AI Hub`
                ].join('\n')
            }]);
            return `Verification code sent to ${username}.`;
        } catch (mailErr) {
            console.error('[AuthService] sendMail error:', mailErr?.message);
            return req.error(500, 'Could not send verification email. Please try again.');
        }
    }

    // ── Verify OTP ────────────────────────────────────────────────────────────
    static async verifyOTP(req) {
        const username = sanitiseUsername(req.data.username);
        const otp      = (req.data.otp || '').toString().trim();

        if (!username || !otp) return req.reject(400, 'username and otp are required.');

        const user = await SELECT.one.from('sap.aigateway.Users').where({ username });
        // Always check expiry before value — prevents timing oracle
        if (!user || new Date(user.otpExpiry) < new Date()) {
            return req.reject(400, 'Invalid or expired verification code.');
        }
        if (!safeEqual(user.otp, otp)) {
            return req.reject(400, 'Invalid or expired verification code.');
        }

        await UPDATE('sap.aigateway.Users')
            .set({ isVerified: true, otp: null, otpExpiry: null })
            .where({ username });

        const tokens = await buildAuthTokens(user.ID, username);
        return tokens;
    }

    // ── Login ─────────────────────────────────────────────────────────────────
    static async login(req) {
        const username = sanitiseUsername(req.data.username);
        const password = (req.data.password || '').toString();

        if (!isValidEmail(username)) {
            return req.reject(400, `Only ${ALLOWED_EMAIL_DOMAIN} accounts are allowed.`);
        }
        if (!password) return req.reject(400, 'Password is required.');

        const user = await SELECT.one.from('sap.aigateway.Users').where({ username });

        // Dummy hash — ensures bcrypt.compare runs even for unknown users (prevents timing enumeration)
        const DUMMY_HASH = '$2b$12$aaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const hashToCheck = user?.passwordHash || DUMMY_HASH;

        // Account lock check (after DB fetch, before bcrypt — fast rejection)
        if (user?.lockedUntil && new Date(user.lockedUntil) > new Date()) {
            return req.reject(429,
                'Account temporarily locked due to too many failed attempts. Please try again later.');
        }

        const passwordMatch = await bcrypt.compare(password, hashToCheck);

        if (!user || !passwordMatch) {
            if (user) {
                const newFailed = (user.failedLogins || 0) + 1;
                const updates   = { failedLogins: newFailed };
                if (newFailed >= MAX_FAILED_LOGINS) {
                    updates.lockedUntil = new Date(Date.now() + ACCOUNT_LOCK_DURATION).toISOString();
                    console.warn(`[AuthService] Account locked: ${username} after ${newFailed} attempts`);
                }
                await UPDATE('sap.aigateway.Users').set(updates).where({ username });
            }
            return req.reject(401, 'Invalid credentials.');
        }

        if (!user.isVerified) {
            return req.reject(403, 'Email not verified. Please register to get a new code.');
        }

        // Reset failed counter on successful login
        if ((user.failedLogins || 0) > 0) {
            await UPDATE('sap.aigateway.Users')
                .set({ failedLogins: 0, lockedUntil: null })
                .where({ username });
        }

        const tokens = await buildAuthTokens(user.ID, username);
        return tokens;
    }

    // ── Refresh token ─────────────────────────────────────────────────────────
    static async refreshToken(req) {
        const refreshTokenValue = (req.data.refreshToken || '').toString().trim();
        if (!refreshTokenValue) return req.reject(400, 'refreshToken is required.');

        try {
            const { userId } = await rotateRefreshToken(refreshTokenValue);
            const user        = await SELECT.one.from('sap.aigateway.Users').where({ ID: userId });
            if (!user) return req.reject(401, 'User not found.');

            const tokens = await buildAuthTokens(user.ID, user.username);
            return tokens;
        } catch (err) {
            return req.reject(401, err.message || 'Invalid refresh token.');
        }
    }

    // ── Logout ────────────────────────────────────────────────────────────────
    static async logout(req) {
        const refreshTokenValue = (req.data.refreshToken || '').toString().trim();
        if (refreshTokenValue) {
            try { await revokeRefreshToken(refreshTokenValue); } catch { /* already gone */ }
        }
        return 'Logged out successfully.';
    }

    // ── Forgot Password — sends OTP to registered email ───────────────────────
    static async forgotPassword(req) {
        const username = sanitiseUsername(req.data.username);

        if (!isValidEmail(username)) {
            return req.reject(400, `Only ${ALLOWED_EMAIL_DOMAIN} emails are accepted.`);
        }

        // Rate limit: 1 request per email per 60 s (prevents OTP-spam to real users)
        try { checkForgotPasswordRateLimit(username); }
        catch (err) { return req.reject(429, err.message); }

        const user = await SELECT.one.from('sap.aigateway.Users').where({ username });

        // Always return the same neutral message whether the email is registered or not.
        // This prevents account enumeration.
        const NEUTRAL_MSG = 'If this email is registered, a password reset code has been sent.';

        if (!user || !user.isVerified) return NEUTRAL_MSG;

        const otp       = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000).toISOString();

        await UPDATE('sap.aigateway.Users')
            .set({ otp, otpExpiry })
            .where({ username });

        try {
            await sendMail({ destinationName: 'sap_process_automation_mail' }, [{
                to:      username,
                subject: 'AnswerThink Enterprise AI Hub — Password Reset Code',
                text: [
                    `Hello,`,
                    ``,
                    `You requested a password reset. Your one-time code is: ${otp}`,
                    ``,
                    `This code is valid for ${OTP_EXPIRY_MINUTES} minutes.`,
                    `If you did not request this, please ignore this email.`,
                    ``,
                    `— AnswerThink Enterprise AI Hub`
                ].join('\n')
            }]);
            return NEUTRAL_MSG;
        } catch (mailErr) {
            console.error('[AuthService] forgotPassword sendMail error:', mailErr?.message);
            return req.error(500, 'Could not send reset email. Please try again.');
        }
    }

    // ── Reset Password — validates OTP then saves new password ────────────────
    static async resetPassword(req) {
        const username    = sanitiseUsername(req.data.username);
        const otp         = (req.data.otp || '').toString().trim();
        const newPassword = (req.data.newPassword || '').toString();

        if (!username || !otp) return req.reject(400, 'username and otp are required.');
        if (newPassword.length < 8 || newPassword.length > 128) {
            return req.reject(400, 'Password must be 8–128 characters.');
        }

        const user = await SELECT.one.from('sap.aigateway.Users').where({ username });

        // Check expiry before value — prevents timing oracle
        if (!user || !user.isVerified || !user.otp || new Date(user.otpExpiry) < new Date()) {
            return req.reject(400, 'Invalid or expired reset code.');
        }
        if (!safeEqual(user.otp, otp)) {
            return req.reject(400, 'Invalid or expired reset code.');
        }

        const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

        await UPDATE('sap.aigateway.Users')
            .set({ passwordHash, otp: null, otpExpiry: null, failedLogins: 0, lockedUntil: null })
            .where({ username });

        // Clear rate-limit entry so the user can request again if needed
        _fpLastSent.delete(username);

        return 'Password has been reset successfully. Please log in with your new password.';
    }

    // ── Rating ────────────────────────────────────────────────────────────────
    static async submitRating(req) {
        const { userId, modelId, category, rating } = req.data;
        if (!userId || !modelId || !category || rating === undefined) {
            return req.reject(400, 'All rating fields are required.');
        }
        const r = Number(rating);
        if (!Number.isInteger(r) || r < 1 || r > 5) {
            return req.reject(400, 'Rating must be an integer between 1 and 5.');
        }
        await INSERT.into('sap.aigateway.Ratings').entries({ userId, modelId, category, rating: r });
        return 'Success';
    }
}

module.exports = AuthService;