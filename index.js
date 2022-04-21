const NEXT_CONTACT_BATCH_KEY = 'next_hubspot_contacts_url'
const SYNC_LAST_COMPLETED_DATE_KEY = 'last_job_complete_day'
const NEXT_DEAL_BATCH_KEY = 'next_hubspot_deals_url'
const NEXT_COMPANY_BATCH_KEY = 'next_hubspot_companies_url'

const jobs = {
    'Clear storage': async (_, { storage }) => {
        await storage.del(NEXT_CONTACT_BATCH_KEY)
        await storage.del(SYNC_LAST_COMPLETED_DATE_KEY)
    }
}

async function setupPlugin({ config, global }) {
    global.hubspotAuth = `hapikey=${config.hubspotApiKey}`
    global.posthogUrl = config.postHogUrl
    global.apiToken = config.postHogApiToken
    global.projectToken = config.postHogProjectToken

    global.syncScoresIntoPosthog = global.posthogUrl && global.apiToken && global.projectToken

    const authResponse = await fetchWithRetry(
        `https://api.hubapi.com/crm/v3/objects/contacts?limit=1&paginateAssociations=false&archived=false&${global.hubspotAuth}`
    )

    if (!statusOk(authResponse)) {
        throw new Error('Unable to connect to Hubspot. Please make sure your API key is correct.')
    }
}

async function updateHubspotScore(email, hubspotScore, global) {
    let updated = false
    const _userRes = await fetch(`${global.posthogUrl}/api/person/?token=${global.projectToken}&email=${email}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${global.apiToken}` }
    })
    const userResponse = await _userRes.json()

    if (userResponse['results'] && userResponse['results'].length > 0) {
        for (const loadedUser of userResponse['results']) {
            const userId = loadedUser['id']
            const currentProps = loadedUser['properties'] ?? {}
            const updatedProps = { hubspot_score: parseInt(hubspotScore, 10), ...currentProps }

            if (userId) {
                const _updateRes = await fetch(
                    `${global.posthogUrl}/api/person/${userId}/?token=${global.projectToken}`,
                    {
                        method: 'PATCH',
                        headers: {
                            Authorization: `Bearer ${global.apiToken}`,
                            Accept: 'application/json',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            properties: updatedProps
                        })
                    }
                )
                updated = true
            }
        }
    }

    return updated
}

async function getHubspotContacts(config, global, storage) {
    console.log('Loading Hubspot Contacts...')
    const properties = [
        'email',
        'hubspotscore',
        'company',
        'firstname',
        'lastname',
        'phone',
        'address',
        'city',
        'state',
        'zip',
        'country',
        'website'
    ]
    const associations = ['companies']

    let requestUrl = await storage.get(NEXT_CONTACT_BATCH_KEY)
    if (!requestUrl) {
        const lastFinishDate = await storage.get(SYNC_LAST_COMPLETED_DATE_KEY)
        const dateObj = new Date()
        const todayStr = `${dateObj.getUTCFullYear()}-${dateObj.getUTCMonth()}-${dateObj.getUTCDate()}`
        if (todayStr === lastFinishDate) {
            console.log(`Not syncing contacts - sync already completed for ${todayStr}`)
            return []
        }
        // start fresh - begin processing all contacts
        requestUrl = `https://api.hubapi.com/crm/v3/objects/contacts?limit=100&paginateAssociations=false&archived=false&${
            global.hubspotAuth
        }&properties=${properties.join(',')}&associations=${associations.join(',')}`
    }

    const loadedContacts = []
    const response = await fetchWithRetry(requestUrl)
    const res = await response.json()

    if (!statusOk(response) || res.status === 'error') {
        const errorMessage = res.message ?? ''
        console.error(
            `Unable to get contacts from Hubspot. Status Code: ${response.status}. Error message: ${errorMessage}`
        )
    }

    if (res && res['results']) {
        res['results'].forEach((hubspotContact) => {
            const props = hubspotContact['properties']
            loadedContacts.push({ email: props['email'], score: props['hubspotscore'] })
            posthog.capture('hubspot_contact', {
                distinct_id: props['email'],
                $set: {
                    email: props['email'], // update email so that it don't show random name when user not exists
                    hubspot_company: props['company'],
                    hubspot_firstname: props['firstname'],
                    hubspot_lastname: props['lastname'],
                    hubspot_phone: props['phone'],
                    hubspot_address: props['address'],
                    hubspot_city: props['city'],
                    hubspot_state: props['state'],
                    hubspot_zip: props['zip'],
                    hubspot_country: props['country'],
                    hubspot_website: props['website']
                }
            })
            // set related company group
            if (
                config.companiesGroupType &&
                hubspotContact['associations'] &&
                hubspotContact['associations']['companies']
            ) {
                hubspotContact['associations']['companies']['results'].forEach((company) => {
                    posthog.capture('$groupidentify', {
                        distinct_id: props['email'],
                        $groups: { [config.companiesGroupType]: company['id'] }
                    })
                })
            }
        })
    }

    let nextContactBatch
    if (res['paging'] && res['paging']['next']) {
        nextContactBatch = res['paging']['next']['link'] + `&${global.hubspotAuth}`
    }

    await storage.set(NEXT_CONTACT_BATCH_KEY, nextContactBatch)
    console.log(`Loaded ${loadedContacts.length} Contacts from Hubspot`)
    return loadedContacts
}

async function fetchAllDeals(config, global, storage) {
    if (!config.dealsGroupType) {
        console.log('No deals group type defined. Skipping fetching deals')
        return []
    }
    const associations = ['companies']
    let requestUrl = await storage.get(NEXT_DEAL_BATCH_KEY)
    if (!requestUrl) {
        requestUrl = `https://api.hubapi.com/crm/v3/objects/deals?limit=100&paginateAssociations=false&archived=false&${
            global.hubspotAuth
        }&associations=${associations.join(',')}`
    }
    const response = await fetchWithRetry(requestUrl)
    const res = await response.json()
    if (!statusOk(response) || res.status === 'error') {
        const errorMessage = res.message ?? ''
        console.error(
            `Unable to get deals from Hubspot. Status Code: ${response.status}. Error message: ${errorMessage}`
        )
    }
    if (res && res['results']) {
        for (hubspotDeal of res['results']) {
            const exists = await storage.get(hubspotDeal['id'], false)
            if (exists) {
                console.log(`Deal ${hubspotDeal['id']} already exists`)
                continue
            } else {
                storage.set(hubspotDeal['id'], true)
                console.log(`Found new deal: ${hubspotDeal['id']}`)
            }
            const props = hubspotDeal['properties']
            props['name'] = props['dealname'] // set name to dealname so that it doesn't show deal id in the groups list
            posthog.capture('$groupidentify', {
                $group_type: config.dealsGroupType,
                $group_key: hubspotDeal['id'],
                $group_set: props
            })
            // set related company group
            if (config.companiesGroupType && hubspotDeal['associations'] && hubspotDeal['associations']['companies']) {
                hubspotDeal['associations']['companies']['results'].forEach((company) => {
                    posthog.capture('$groupidentify', {
                        $groups: {
                            [config.companiesGroupType]: company['id'],
                            [config.dealsGroupType]: hubspotDeal['id']
                        }
                    })
                })
            }
        }
    }
    let nextDealBatch = null
    if (res['paging'] && res['paging']['next']) {
        nextDealBatch = res['paging']['next']['link'] + `&${global.hubspotAuth}`
    }
    await storage.set(NEXT_DEAL_BATCH_KEY, nextDealBatch)
}

async function fetchAllCompanies(config, global, storage) {
    if (!config.companiesGroupType) {
        console.log('No companies group type defined. Skipping fetching companies')
        return []
    }
    let requestUrl = await storage.get(NEXT_COMPANY_BATCH_KEY)
    const properties = [
        'name',
        'hubspotscore',
        'city',
        'state',
        'zip',
        'country',
        'website',
        'industry',
        'total_revenue',
        'total_money_raised',
        'hs_num_open_deals',
        'hs_total_deal_value',
        'num_associated_deals',
        'annualrevenue',
        'numberofemployees'
    ]
    if (!requestUrl) {
        requestUrl = `https://api.hubapi.com/crm/v3/objects/companies?limit=100&archived=false&${
            global.hubspotAuth
        }&properties=${properties.join(',')}`
    }
    const response = await fetchWithRetry(requestUrl)
    const res = await response.json()
    if (!statusOk(response) || res.status === 'error') {
        const errorMessage = res.message ?? ''
        console.error(
            `Unable to get companies from Hubspot. Status Code: ${response.status}. Error message: ${errorMessage}`
        )
    }
    if (res && res['results']) {
        for (hubspotCompany of res['results']) {
            const exists = await storage.get(hubspotCompany['id'], false)
            if (exists) {
                console.log(`Company ${hubspotCompany['id']} already exists`)
                continue
            } else {
                storage.set(hubspotCompany['id'], true)
                console.log(`Found new company: ${hubspotCompany['id']}`)
            }
            const props = hubspotCompany['properties']
            posthog.capture('$groupidentify', {
                $group_type: config.companiesGroupType,
                $group_key: hubspotCompany['id'],
                $group_set: props
            })
        }
    }
    let nextCompanyBatch
    if (res['paging'] && res['paging']['next']) {
        nextCompanyBatch = res['paging']['next']['link'] + `&${global.hubspotAuth}`
    }
    await storage.set(NEXT_COMPANY_BATCH_KEY, nextCompanyBatch)
}

async function runEveryMinute({ config, global, storage }) {
    console.log('fetching hubspot companies')
    await fetchAllCompanies(config, global, storage)

    console.log('fetching hubspot deals')
    await fetchAllDeals(config, global, storage)

    console.log('Starting score sync job...')
    posthog.capture('hubspot score sync started')

    if (!global.syncScoresIntoPosthog) {
        console.log('Not syncing Hubspot Scores into PostHog - config not set.')
    }

    const loadedContacts = await getHubspotContacts(config, global, storage)
    let skipped = 0
    let num_updated = 0
    let num_processed = 0
    let num_errors = 0
    for (const hubspotContact of loadedContacts) {
        console.log(`Processed...${num_processed} Person updates`)
        const email = hubspotContact['email']
        const score = hubspotContact['score']
        try {
            const updated = await updateHubspotScore(email, score, global)
            if (updated) {
                num_updated += 1
                console.log(`Updated Person ${email} with score ${score}`)
                posthog.capture('hubspot score updated', { distinct_id: email, hubspot_score: score })
            } else {
                skipped += 1
            }
        } catch (error) {
            console.log(`Error updating Hubspot score for ${email} - Skipping`)
            num_errors += 1
        }
        num_processed += 1
    }

    console.log(
        `Successfully updated Hubspot scores for ${num_updated} records, skipped ${skipped} records, processed ${loadedContacts.length} Hubspot Contacts, errors: ${num_errors} `
    )
    const nextContactBatch = await storage.get(NEXT_CONTACT_BATCH_KEY)
    if (!nextContactBatch) {
        posthog.capture('hubspot contact sync all contacts completed', { num_updated: num_updated })
        const dateObj = new Date()
        await storage.set(
            SYNC_LAST_COMPLETED_DATE_KEY,
            `${dateObj.getUTCFullYear()}-${dateObj.getUTCMonth()}-${dateObj.getUTCDate()}`
        )
    } else {
        posthog.capture('hubspot contact sync batch completed', { num_updated: num_updated })
    }
}

async function onEvent(event, { config, global }) {
    const triggeringEvents = (config.triggeringEvents || '').split(',')
    if (triggeringEvents.indexOf(event.event) >= 0) {
        const email = getEmailFromEvent(event)
        if (email) {
            const emailDomainsToIgnore = (config.ignoredEmails || '').split(',')
            if (emailDomainsToIgnore.indexOf(email.split('@')[1]) >= 0) {
                return
            }
            await createHubspotContact(
                email,
                {
                    ...(event['$set'] ?? {}),
                    ...(event['properties'] ?? {})
                },
                global.hubspotAuth,
                config.additionalPropertyMappings,
                event['sent_at']
            )
        }
    }
}

async function createHubspotContact(email, properties, authQs, additionalPropertyMappings, eventSendTime) {
    let hubspotFilteredProps = {}
    for (const [key, val] of Object.entries(properties)) {
        if (hubspotPropsMap[key]) {
            hubspotFilteredProps[hubspotPropsMap[key]] = val
        }
    }

    if (additionalPropertyMappings) {
        for (let mapping of additionalPropertyMappings.split(',')) {
            const [postHogProperty, hubSpotProperty] = mapping.split(':')
            if (postHogProperty && hubSpotProperty) {
                // special case to convert an event's timestamp to the format Hubspot uses them
                if (postHogProperty === 'sent_at' || postHogProperty === 'created_at') {
                    const d = new Date(eventSendTime)
                    d.setUTCHours(0, 0, 0, 0)
                    hubspotFilteredProps[hubSpotProperty] = d.getTime()
                } else if (postHogProperty in properties) {
                    hubspotFilteredProps[hubSpotProperty] = properties[postHogProperty]
                }
            }
        }
    }

    const addContactResponse = await fetchWithRetry(
        `https://api.hubapi.com/crm/v3/objects/contacts?${authQs}`,
        {
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ properties: { email: email, ...hubspotFilteredProps } })
        },
        'POST'
    )

    const addContactResponseJson = await addContactResponse.json()

    if (!statusOk(addContactResponse) || addContactResponseJson.status === 'error') {
        const errorMessage = addContactResponseJson.message ?? ''
        console.log(
            `Unable to add contact ${email} to Hubspot. Status Code: ${addContactResponse.status}. Error message: ${errorMessage}`
        )
        if (addContactResponse.status === 409) {
            const existingIdRegex = /Existing ID: ([0-9]+)/
            const existingId = addContactResponseJson.message.match(existingIdRegex)
            console.log(`Attempting to update contact ${email} instead...`)

            const updateContactResponse = await fetchWithRetry(
                `https://api.hubapi.com/crm/v3/objects/contacts/${existingId[1]}?${authQs}`,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ properties: { email: email, ...hubspotFilteredProps } })
                },
                'PATCH'
            )

            const updateResponseJson = await updateContactResponse.json()
            if (!statusOk(updateContactResponse)) {
                const errorMessage = updateResponseJson.message ?? ''
                console.log(
                    `Unable to update contact ${email} to Hubspot. Status Code: ${updateContactResponse.status}. Error message: ${errorMessage}`
                )
            } else {
                console.log(`Successfully updated Hubspot Contact for ${email}`)
            }
        }
    } else {
        console.log(`Created Hubspot Contact for ${email}`)
    }
}

async function fetchWithRetry(url, options = {}, method = 'GET', isRetry = false) {
    try {
        const res = await fetch(url, { method: method, ...options })
        return res
    } catch {
        if (isRetry) {
            throw new Error(`${method} request to ${url} failed.`)
        }
        const res = await fetchWithRetry(url, options, (method = method), (isRetry = true))
        return res
    }
}

function statusOk(res) {
    return String(res.status)[0] === '2'
}

function isEmail(email) {
    const re = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    return re.test(String(email).toLowerCase())
}

function getEmailFromEvent(event) {
    if (isEmail(event.distinct_id)) {
        return event.distinct_id
    } else if (event['$set'] && Object.keys(event['$set']).includes('email')) {
        if (isEmail(event['$set']['email'])) {
            return event['$set']['email']
        }
    } else if (event['properties'] && Object.keys(event['properties']).includes('email')) {
        if (isEmail(event['properties']['email'])) {
            return event['properties']['email']
        }
    }

    return null
}

const hubspotPropsMap = {
    companyName: 'company',
    company_name: 'company',
    company: 'company',
    lastName: 'lastname',
    last_name: 'lastname',
    lastname: 'lastname',
    firstName: 'firstname',
    first_name: 'firstname',
    firstname: 'firstname',
    phone_number: 'phone',
    phoneNumber: 'phone',
    phone: 'phone',
    website: 'website',
    domain: 'website',
    company_website: 'website',
    companyWebsite: 'website'
}

module.exports = {
    jobs,
    setupPlugin,
    runEveryMinute,
    onEvent,
    fetchAllCompanies,
    fetchAllDeals
}
