'use strict';
const { sendMail } = require('@sap-cloud-sdk/mail-client');
const { MAX_CHATS_PER_USER } = require('../utils/constants');

class AuthService {
    static async checkChatLimits(req) {
        const { userId } = req.data;
        if (!userId) return;

        const [{ count }] = await SELECT
            .from('sap.aigateway.ChatSessions')
            .columns('count(*) as count')
            .where({ userId });

        if (Number(count) >= MAX_CHATS_PER_USER) {
            return req.reject(403, `Maximum of ${MAX_CHATS_PER_USER} chats reached. Please delete an older chat to create a new one.`);
        }
    }

    static async register(req) {
        const { username, password } = req.data;

        if (!username.toLowerCase().endsWith('@answerthink.com')) {
            return req.reject(400, 'Registration is restricted to @answerthink.com emails only.');
        }

        const existing = await SELECT.one.from('sap.aigateway.Users').where({ username });
        if (existing?.isVerified) {
            return req.reject(400, 'User already exists and is verified. Please log in.');
        }

        const otp       = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        if (existing && !existing.isVerified) {
            await UPDATE('sap.aigateway.Users').set({ password, otp, otpExpiry }).where({ username });
        } else {
            await INSERT.into('sap.aigateway.Users').entries({ username, password, otp, otpExpiry, isVerified: false });
        }

        try {
            await sendMail({ destinationName: 'sap_process_automation_mail' }, [{
                to:      username,
                subject: 'AnswerThink Enterprise AI Hub - Registration OTP',
                text:    `Your one-time password (OTP) is: ${otp}. It is valid for 10 minutes.`
            }]);
            return `An OTP has been sent to ${username}.`;
        } catch (err) {
            console.error('sendMail error:', err?.message || err);
            return req.error(500, 'Could not send the verification email.');
        }
    }

    static async verifyOTP(req) {
        const { username, otp } = req.data;
        const user = await SELECT.one.from('sap.aigateway.Users').where({ username, otp });

        if (!user) return req.reject(400, 'Invalid OTP.');
        if (new Date(user.otpExpiry) < new Date()) return req.reject(400, 'OTP has expired. Please register again.');

        await UPDATE('sap.aigateway.Users')
            .set({ isVerified: true, otp: null, otpExpiry: null })
            .where({ username });

        return user.ID;
    }

    static async login(req) {
        const { username, password } = req.data;

        if (!username.toLowerCase().endsWith('@answerthink.com')) {
            return req.reject(400, 'Only @answerthink.com emails are allowed.');
        }

        const user = await SELECT.one.from('sap.aigateway.Users').where({ username, password });
        if (!user)            return req.reject(401, 'Invalid credentials or Register your User.');
        if (!user.isVerified) return req.reject(403, 'Email not verified. Please register to generate a new OTP.');

        return user.ID;
    }

    static async submitRating(req) {
        const { userId, modelId, category, rating } = req.data;
        await INSERT.into('sap.aigateway.Ratings').entries({ userId, modelId, category, rating });
        return 'Success';
    }
}

module.exports = AuthService;